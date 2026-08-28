import { AgentTransportError, type AgentClient } from "@sre/agent-client";
import type { AgentExecutionRequest } from "@sre/agent-protocol";
import type { AgentRegistry } from "@sre/agent-registry";
import type { DelegatedIdentityIssuer } from "@sre/auth";
import type { ManagerAgentConfig } from "@sre/config";
import type { Evidence, RuntimeError, SpecialistResult } from "@sre/evidence";
import { reduceEvidence } from "@sre/evidence-processing";
import { redactText } from "@sre/redaction";
import type { ModelClient } from "@sre/llm";
import { classifyIntent, deterministicRoute, ManagerRouter, resolveAbstentionFanout, type ManagerDecision } from "@sre/routing";
import { incrementMetric, withSpan } from "@sre/telemetry";
import { deterministicMultiSpecialistResponse, deterministicResponseBuilder } from "./deterministic-response-builder.ts";
import { planRound2, round2RejectionEvidence } from "./round2.ts";
import { shouldEscalate } from "./synthesis-gate.ts";
import { synthesizeResponse } from "./synthesis.ts";
import type { AssistantResponse, ExecutionContext, UserRequest } from "./types.ts";

export interface RuntimeDependencies {
  manager: ManagerAgentConfig;
  registry: AgentRegistry;
  agentClient: AgentClient;
  identityIssuer: DelegatedIdentityIssuer;
  model: ModelClient;
  synthesisModel: ModelClient;
  requestDeadlineMs: number;
  defaultEnvironment: string;
  onResults?: (results: SpecialistResult[]) => void;
}

export async function executeRequest(req: UserRequest, deps: RuntimeDependencies): Promise<AssistantResponse> {
  // the single absolute deadline is fixed at request entry, BEFORE routing, and
  // covers every downstream stage (Stage-1, Manager LLM, fan-out, MCP,
  // Round 2, Tier-L). One AbortController fires at that deadline for all of them.
  const deadline = Date.now() + deps.requestDeadlineMs;
  const requestController = new AbortController();
  const requestTimer = setTimeout(() => requestController.abort(deadlineError()), Math.max(1, deadline - Date.now()));
  try {
    return await executeWithinDeadline(req, deps, deadline, requestController.signal);
  } finally {
    clearTimeout(requestTimer);
  }
}

async function executeWithinDeadline(req: UserRequest, deps: RuntimeDependencies, deadline: number, signal: AbortSignal): Promise<AssistantResponse> {
  const modelSafeQuestion = redactText(req.question).value;
  const environment = req.environment ?? deps.defaultEnvironment;
  const configured = new Set(deps.manager.spec.agents.allowed);
  const enabledAllowed = deps.registry.listEnabled(environment).filter((agent) => configured.has(agent.agentId));
  const allAgentIds = enabledAllowed.map((agent) => agent.agentId);
  // routing rules come from the registry (config), not from code — see agents/registry.yaml
  const rules = enabledAllowed.map((agent) => ({ agentId: agent.agentId, ...agent.routing }));
  const stage1 = await withSpan("manager.route.stage1", { "request.id": req.identity.requestId, environment }, async () => deterministicRoute(req.question, rules));
  const authorizedCandidates = deps.registry.filterAuthorized(allAgentIds, req.identity.roles, environment);
  const defaultTask = `Investigate this request within your domain and return cited evidence: ${modelSafeQuestion}`.slice(0, 2000);
  let routing: ManagerDecision;
  // deterministic fast path applies ONLY to narrow factual requests; diagnostic,
  // causal, ambiguous or potentially cross-domain questions go to the Manager
  const fastPath = stage1.resolved && stage1.decision !== undefined && stage1.intent === "factual";
  if (fastPath && stage1.decision !== undefined) {
    routing = { routes: stage1.decision.agents.map((agent) => ({ agent, task: defaultTask })), confidence: 1, abstain: false, reasonCodes: [stage1.decision.reasonCode] };
  } else {
    if (authorizedCandidates.length === 0) return authorizationDenied(req.identity.requestId);
    try {
      incrementMetric("sre_manager_invocations_total");
      // the Manager LLM call shares the request deadline signal
      routing = await withSpan("manager.route.llm", { "request.id": req.identity.requestId, environment }, () => new ManagerRouter(deps.model, deps.registry, deps.manager).selectAgents(modelSafeQuestion, authorizedCandidates, stage1.entities, signal));
    } catch {
      return signal.aborted ? requestTimeout(req.identity.requestId) : routeInvalid(req.identity.requestId);
    }
  }

  const intent = classifyIntent(req.question, routing.reasonCodes);
  const ctx: ExecutionContext = {
    request: { ...req, question: modelSafeQuestion },
    identity: req.identity,
    environment,
    intent,
    requestId: req.identity.requestId,
    deadline,
    signal,
  };
  let requestedRoutes = routing.routes;
  if (routing.abstain) {
    incrementMetric("sre_manager_abstentions_total");
    const ambiguityFanout = resolveAbstentionFanout(routing, authorizedCandidates, deps.manager.spec.execution.maxAgentsPerRequest);
    if (ambiguityFanout.length === 0) return clarification(ctx.requestId);
    requestedRoutes = ambiguityFanout.map((agent) => ({ agent, task: defaultTask }));
  }
  const authorizedSet = new Set(deps.registry.filterAuthorized(requestedRoutes.map((route) => route.agent), ctx.identity.roles, ctx.environment));
  const authorizedRoutes = requestedRoutes.filter((route) => authorizedSet.has(route.agent));
  const authorizedAgents = authorizedRoutes.map((route) => route.agent);
  if (authorizedRoutes.length === 0) return authorizationDenied(ctx.requestId);

  const settled = await withSpan("manager.fanout", { "request.id": ctx.requestId, "agent.count": authorizedRoutes.length }, () => Promise.allSettled(
    authorizedRoutes.map((route) => executeAgent(route.agent, ctx, deps, signal, undefined, route.task)),
  ));
  const results: SpecialistResult[] = settled.map((item, index): SpecialistResult => item.status === "fulfilled" ? item.value : specialistFailure(authorizedAgents[index] as string, ctx, item.reason));

  const round2 = await withSpan("round2.resolve", { "request.id": ctx.requestId, "round.number": 2 }, async () => planRound2({
    results,
    alreadyRun: authorizedAgents,
    ctx,
    registry: deps.registry,
    entities: stage1.entities,
    budgetUsed: false,
    maxAgentsPerRequest: deps.manager.spec.execution.maxAgentsPerRequest,
    allowedManagerAgents: deps.manager.spec.agents.allowed,
  }));
  const rejectionEvidence = round2RejectionEvidence(round2.rejections, ctx);
  if (rejectionEvidence.length > 0 && results[0] !== undefined) results[0].evidence.push(...rejectionEvidence);
  if (round2.request !== undefined) {
    incrementMetric("sre_round2_total");
    const request = round2.request;
    try {
      results.push(await withSpan(`agent.${request.agentId}.execute`, { "request.id": ctx.requestId, "round.number": 2, "agent.id": request.agentId }, () => executeAgent(request.agentId, ctx, deps, signal, request.handoff)));
    } catch (error) {
      results.push(specialistFailure(request.agentId, ctx, error));
    }
  }
  deps.onResults?.(structuredClone(results));
  const reduced = await withSpan("evidence.reduce", { "request.id": ctx.requestId }, async () => reduceEvidence(results));
  const escalate = await withSpan("synthesis.gate", { "request.id": ctx.requestId, "evidence.count": reduced.evidence.length }, async () => shouldEscalate(ctx, reduced));
  if (escalate) {
    try { return await synthesizeResponse(ctx, reduced, results, deps.synthesisModel); }
    catch (error) {
      incrementMetric("sre_tier_l_failures_total");
      const reason = tierLFailureReason(error, signal);
      const contributing = results.filter((result) => result.status !== "failed");
      // more than one contributor → keep every summary; never collapse to the first specialist
      if (contributing.length > 1 || results.length > 1) return deterministicMultiSpecialistResponse(ctx, results, reason);
      const fallback = results[0];
      if (fallback !== undefined) {
        const response = deterministicResponseBuilder(ctx, fallback);
        return { ...response, evidenceGaps: [...response.evidenceGaps, { source: "tier-l", reason }], degraded: true };
      }
    }
  }
  const first = results[0];
  if (first === undefined) return noEvidence(ctx.requestId, authorizedAgents);
  const response = await withSpan("response.build", { "request.id": ctx.requestId, "evidence.count": first.evidence.length }, async () => deterministicResponseBuilder(ctx, first));
  return { ...response, metadata: { ...response.metadata, routedAgents: results.map((result) => result.agentId) } };
}

async function executeAgent(agentId: string, ctx: ExecutionContext, deps: RuntimeDependencies, signal: AbortSignal, handoff?: AgentExecutionRequest["handoff"], task?: string): Promise<SpecialistResult> {
  const identityContext = await deps.identityIssuer.issue(ctx.identity, `sre-agent:${agentId}`, ctx.deadline);
  const request: AgentExecutionRequest = {
    requestId: ctx.requestId,
    question: ctx.request.question,
    environment: ctx.environment,
    identityContext,
    ...(task ? { task } : {}),
    ...(ctx.request.conversation?.resolvedEntities ? { conversationContext: { resolvedEntities: ctx.request.conversation.resolvedEntities } } : {}),
    ...(handoff ? { handoff } : {}),
    deadline: new Date(ctx.deadline).toISOString(),
  };
  return withSpan(`agent.${agentId}.execute`, { "request.id": ctx.requestId, "agent.id": agentId }, () => deps.agentClient.execute(agentId, request, signal));
}

function specialistFailure(agentId: string, ctx: ExecutionContext, error: unknown): SpecialistResult {
  const mapped = mapAgentError(error);
  const status = mapped.code === "AGENT_UNAUTHORIZED" ? "denied" : "failed";
  const evidence: Evidence = {
    id: `agent:${agentId}:${mapped.code.toLowerCase()}`,
    kind: "missing",
    source: agentId,
    system: "agent-service",
    environment: ctx.environment,
    citation: `agent://${agentId}`,
    status,
    requestId: ctx.requestId,
    agentId,
  };
  return { agentId, status: "failed", evidence: [evidence], errors: [mapped] };
}

function mapAgentError(error: unknown): RuntimeError {
  if (error instanceof AgentTransportError) return { code: error.code, message: safeAgentError(error.code), retryable: error.retryable };
  return { code: "AGENT_UNAVAILABLE", message: "A specialist service was unavailable", retryable: true };
}

function safeAgentError(code: AgentTransportError["code"]): string {
  if (code === "AGENT_TIMEOUT") return "A specialist service timed out";
  if (code === "AGENT_UNAUTHORIZED") return "A specialist service denied the request";
  if (code === "AGENT_EXECUTION_FAILED") return "A specialist service failed internally";
  if (code === "AGENT_RESPONSE_TOO_LARGE") return "A specialist response exceeded the safe size limit";
  if (code === "AGENT_INVALID_RESPONSE") return "A specialist returned an invalid response";
  return "A specialist service was unavailable";
}

function deadlineError(): Error {
  return Object.assign(new Error("request deadline exceeded"), { code: "REQUEST_TIMEOUT" });
}

function tierLFailureReason(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return "MODEL_TIMEOUT";
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  if (code === "MODEL_INVALID_OUTPUT") return "MODEL_INVALID_OUTPUT";
  if (code === "REQUEST_TIMEOUT" || code === "MODEL_TIMEOUT") return "MODEL_TIMEOUT";
  return "MODEL_UNAVAILABLE";
}

function requestTimeout(requestId: string): AssistantResponse {
  return { requestId, answer: "The request exceeded its time budget before it could be routed.", citations: [], evidenceGaps: [{ source: "routing", reason: "REQUEST_TIMEOUT" }], degraded: true, metadata: { routedAgents: [], tierLUsed: false }, error: { code: "REQUEST_TIMEOUT", message: "Request timed out", retryable: false } };
}

function clarification(requestId: string): AssistantResponse {
  return { requestId, answer: "Please clarify which infrastructure domain or system you want investigated.", citations: [], evidenceGaps: [{ source: "routing", reason: "ROUTE_AMBIGUOUS" }], degraded: true, metadata: { routedAgents: [], tierLUsed: false }, error: { code: "ROUTE_AMBIGUOUS", message: "Clarification required", retryable: false } };
}

function authorizationDenied(requestId: string): AssistantResponse {
  return { requestId, answer: "You are not authorized to access the requested specialist.", citations: [], evidenceGaps: [{ source: "authorization", reason: "AUTHZ_DENIED" }], degraded: true, metadata: { routedAgents: [], tierLUsed: false }, error: { code: "AUTHZ_DENIED", message: "Access denied", retryable: false } };
}

function routeInvalid(requestId: string): AssistantResponse {
  return { requestId, answer: "The request could not be routed safely.", citations: [], evidenceGaps: [{ source: "routing", reason: "ROUTE_INVALID" }], degraded: true, metadata: { routedAgents: [], tierLUsed: false }, error: { code: "ROUTE_INVALID", message: "Routing failed", retryable: false } };
}

function noEvidence(requestId: string, authorizedAgents: string[]): AssistantResponse {
  return { requestId, answer: "The selected evidence sources were unavailable.", citations: [], evidenceGaps: authorizedAgents.map((source) => ({ source, reason: "AGENT_UNAVAILABLE" })), degraded: true, metadata: { routedAgents: authorizedAgents, tierLUsed: false } };
}
