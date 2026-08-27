import { AgentTransportError, type AgentClient } from "@sre/agent-client";
import type { AgentExecutionRequest } from "@sre/agent-protocol";
import type { AgentRegistry } from "@sre/agent-registry";
import type { DelegatedIdentityIssuer } from "@sre/auth";
import type { ManagerAgentConfig } from "@sre/config";
import { redactText, reduceEvidence, type Evidence, type RuntimeError, type SpecialistResult } from "@sre/evidence";
import type { ModelClient } from "@sre/llm";
import { classifyIntent, deterministicRoute, ManagerRouter, resolveAbstentionFanout, type ManagerDecision } from "@sre/routing";
import { incrementMetric, withSpan } from "@sre/telemetry";
import { deterministicResponseBuilder } from "./deterministic-response-builder.ts";
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
  const modelSafeQuestion = redactText(req.question).value;
  const environment = req.environment ?? deps.defaultEnvironment;
  const configured = new Set(deps.manager.spec.agents.allowed);
  const allAgentIds = deps.registry.listEnabled(environment).map((agent) => agent.agentId).filter((agentId) => configured.has(agentId));
  const stage1 = await withSpan("manager.route.stage1", { "request.id": req.identity.requestId, environment }, async () => deterministicRoute(req.question, allAgentIds));
  const authorizedCandidates = deps.registry.filterAuthorized(allAgentIds, req.identity.roles, environment);
  let routing: ManagerDecision;
  if (stage1.resolved && stage1.decision !== undefined) {
    routing = { agents: stage1.decision.agents, confidence: 1, abstain: false, reasonCodes: [stage1.decision.reasonCode] };
  } else {
    if (authorizedCandidates.length === 0) return authorizationDenied(req.identity.requestId);
    try {
      incrementMetric("sre_manager_invocations_total");
      routing = await withSpan("manager.route.llm", { "request.id": req.identity.requestId, environment }, () => new ManagerRouter(deps.model, deps.registry, deps.manager).selectAgents(modelSafeQuestion, authorizedCandidates, stage1.entities));
    } catch {
      return routeInvalid(req.identity.requestId);
    }
  }

  const intent = classifyIntent(req.question, routing.reasonCodes);
  const ctx: ExecutionContext = {
    request: { ...req, question: modelSafeQuestion },
    identity: req.identity,
    environment,
    intent,
    requestId: req.identity.requestId,
    deadline: Date.now() + deps.requestDeadlineMs,
  };
  let requestedAgents = routing.agents;
  if (routing.abstain) {
    incrementMetric("sre_manager_abstentions_total");
    const ambiguityFanout = resolveAbstentionFanout(routing, authorizedCandidates, deps.manager.spec.execution.maxAgentsPerRequest);
    if (ambiguityFanout.length === 0) return clarification(ctx.requestId);
    requestedAgents = ambiguityFanout;
  }
  const authorizedAgents = deps.registry.filterAuthorized(requestedAgents, ctx.identity.roles, ctx.environment);
  if (authorizedAgents.length === 0) return authorizationDenied(ctx.requestId);

  const requestController = new AbortController();
  const requestTimer = setTimeout(() => requestController.abort(), Math.max(1, ctx.deadline - Date.now()));
  let results: SpecialistResult[];
  try {
    const settled = await withSpan("manager.fanout", { "request.id": ctx.requestId, "agent.count": authorizedAgents.length }, () => Promise.allSettled(
      authorizedAgents.map((agentId) => executeAgent(agentId, ctx, deps, requestController.signal)),
    ));
    results = settled.map((item, index): SpecialistResult => item.status === "fulfilled" ? item.value : specialistFailure(authorizedAgents[index] as string, ctx, item.reason));
  } finally {
    clearTimeout(requestTimer);
  }

  const round2 = await withSpan("round2.resolve", { "request.id": ctx.requestId, "round.number": 2 }, async () => planRound2({
    results,
    alreadyRun: authorizedAgents,
    ctx,
    registry: deps.registry,
    entities: stage1.entities,
    budgetUsed: false,
    maxAgentsPerRequest: deps.manager.spec.execution.maxAgentsPerRequest,
  }));
  const rejectionEvidence = round2RejectionEvidence(round2.rejections, ctx);
  if (rejectionEvidence.length > 0 && results[0] !== undefined) results[0].evidence.push(...rejectionEvidence);
  if (round2.request !== undefined) {
    incrementMetric("sre_round2_total");
    const secondController = new AbortController();
    const request = round2.request;
    try {
      results.push(await withSpan(`agent.${request.agentId}.execute`, { "request.id": ctx.requestId, "round.number": 2, "agent.id": request.agentId }, () => executeAgent(request.agentId, ctx, deps, secondController.signal, request.handoff)));
    } catch (error) {
      results.push(specialistFailure(request.agentId, ctx, error));
    }
  }
  deps.onResults?.(structuredClone(results));
  const reduced = await withSpan("evidence.reduce", { "request.id": ctx.requestId }, async () => reduceEvidence(results));
  const escalate = await withSpan("synthesis.gate", { "request.id": ctx.requestId, "evidence.count": reduced.evidence.length }, async () => shouldEscalate(ctx, reduced));
  if (escalate) {
    try { return await synthesizeResponse(ctx, reduced, results, deps.synthesisModel); }
    catch {
      const fallback = results[0];
      if (fallback !== undefined) {
        const response = deterministicResponseBuilder(ctx, fallback);
        return { ...response, evidenceGaps: [...response.evidenceGaps, { source: "tier-l", reason: "MODEL_TIMEOUT" }], degraded: true };
      }
    }
  }
  const first = results[0];
  if (first === undefined) return noEvidence(ctx.requestId, authorizedAgents);
  const response = await withSpan("response.build", { "request.id": ctx.requestId, "evidence.count": first.evidence.length }, async () => deterministicResponseBuilder(ctx, first));
  return { ...response, metadata: { ...response.metadata, routedAgents: results.map((result) => result.agentId) } };
}

async function executeAgent(agentId: string, ctx: ExecutionContext, deps: RuntimeDependencies, signal: AbortSignal, handoff?: AgentExecutionRequest["handoff"]): Promise<SpecialistResult> {
  const identityContext = await deps.identityIssuer.issue(ctx.identity, `sre-agent:${agentId}`, ctx.deadline);
  const request: AgentExecutionRequest = {
    requestId: ctx.requestId,
    question: ctx.request.question,
    environment: ctx.environment,
    identityContext,
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
  if (code === "AGENT_RESPONSE_TOO_LARGE") return "A specialist response exceeded the safe size limit";
  if (code === "AGENT_INVALID_RESPONSE") return "A specialist returned an invalid response";
  return "A specialist service was unavailable";
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
