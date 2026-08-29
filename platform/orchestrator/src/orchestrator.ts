import { AgentTransportError, type AgentExecutionRequest, type SpecialistTransport } from "@sre/agent-protocol";
import type { AgentCatalog } from "@sre/config";
import type { DelegatedIdentityIssuer } from "@sre/auth";
import type { ManagerAgentConfig } from "@sre/config";
import type { Evidence, RuntimeError, RuntimeErrorCode, SpecialistResult } from "@sre/evidence";
import { reduceEvidence } from "./synthesis/index.ts";
import { redactText } from "@sre/redaction";
import type { ModelClient } from "@sre/llm";
import { classifyIntent, extractEntities, ManagerRouter, resolveAbstentionFanout, type ManagerDecision } from "./routing/index.ts";
import { incrementMetric, withSpan } from "@sre/telemetry";
import { planFollowup, followupRejectionEvidence } from "./followup/followup.ts";
import { deterministicMultiSpecialistResponse, deterministicResponseBuilder, shouldEscalate, synthesizeResponse } from "./synthesis/index.ts";
import type { AssistantResponse, ExecutionContext, RoutingTrace, UserRequest } from "./types.ts";

export interface RuntimeDependencies {
  manager: ManagerAgentConfig;
  registry: AgentCatalog;
  agentClient: SpecialistTransport;
  identityIssuer: DelegatedIdentityIssuer;
  model: ModelClient;
  synthesisModel: ModelClient;
  requestDeadlineMs: number;
  defaultEnvironment: string;
  onResults?: (results: SpecialistResult[]) => void;
  /**
   * Reported once per request, including on the paths that return early.
   * Best-effort observability: it must never change the answer, so callers
   * are expected to swallow their own failures.
   */
  onRouting?: (trace: RoutingTrace) => void;
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
  /*
   * Filled in as the request proceeds and reported in the `finally` below, so
   * that the paths which return early — nothing authorized, routing rejected,
   * the deadline blown — are recorded too. Those are precisely the runs an
   * operator most wants to look at, and an emit-before-each-return would
   * eventually miss one.
   */
  const trace: RoutingTrace = { question: modelSafeQuestion, offered: [], selected: [], refused: [], abstained: false };
  try {
    return await route(req, deps, deadline, signal, modelSafeQuestion, trace);
  } finally {
    try { deps.onRouting?.(trace); } catch { /* observability must not change the answer */ }
  }
}

async function route(req: UserRequest, deps: RuntimeDependencies, deadline: number, signal: AbortSignal, modelSafeQuestion: string, trace: RoutingTrace): Promise<AssistantResponse> {
  const environment = req.environment ?? deps.defaultEnvironment;
  const configured = new Set(deps.manager.spec.agents.allowed);
  const enabledAllowed = deps.registry.listEnabled(environment).filter((agent) => configured.has(agent.agentId));
  const allAgentIds = enabledAllowed.map((agent) => agent.agentId);
  const authorizedCandidates = deps.registry.filterAuthorized(allAgentIds, req.identity.roles, environment);
  const defaultTask = `Investigate this request within your domain and return cited evidence: ${modelSafeQuestion}`.slice(0, 2000);

  /*
   * WHO investigates is a semantic judgement, and it is the Manager's alone.
   *
   * A keyword and regex stage used to resolve narrow factual questions before
   * the model was asked at all. It was precise when it fired, but it decided by
   * vocabulary rather than by meaning: an agent was reachable only if someone
   * had written the right phrase into its config, a request worded differently
   * missed it entirely, and onboarding a specialist meant curating a lexicon
   * rather than describing what it does.
   *
   * Nothing about authorization moved. The model proposes agents; every line
   * below still decides whether they may run.
   */
  const entities = extractEntities(req.question);
  trace.offered = allAgentIds;
  if (authorizedCandidates.length === 0) {
    trace.refused = allAgentIds.map((agent) => ({ agent, reason: "AUTHZ_DENIED" }));
    return authorizationDenied(req.identity.requestId);
  }
  let routing: ManagerDecision;
  try {
    incrementMetric("sre_manager_invocations_total");
    // the Manager LLM call shares the request deadline signal
    /*
     * The Manager is offered every ENABLED agent the allowlist permits, not
     * only the ones this principal may use.
     *
     * Selection and authorization are different questions, and collapsing them
     * makes the answer worse: pre-filtering meant a request the caller was not
     * entitled to make came back as whatever the remaining agents could say,
     * instead of as a denial. The model picks on merit; the filter below is
     * authoritative and rejects what the caller may not have. Agent ids and
     * descriptions are not secrets — they are on the console's front page.
     */
    routing = await withSpan("manager.route.llm", { "request.id": req.identity.requestId, environment }, () => new ManagerRouter(deps.model, deps.registry, deps.manager).selectAgents(modelSafeQuestion, allAgentIds, entities, signal));
  } catch (error) {
    if (signal.aborted) return requestTimeout(req.identity.requestId);
    return routingFailure(req.identity.requestId, error);
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
  trace.abstained = routing.abstain;
  if (routing.abstain) {
    incrementMetric("sre_manager_abstentions_total");
    const ambiguityFanout = resolveAbstentionFanout(routing, authorizedCandidates, deps.manager.spec.execution.maxAgentsPerRequest);
    if (ambiguityFanout.length === 0) return clarification(ctx.requestId);
    requestedRoutes = ambiguityFanout.map((agent) => ({ agent, task: defaultTask }));
  }
  trace.selected = requestedRoutes.map((route) => ({ agent: route.agent, task: route.task, ...(route.rationale ? { rationale: route.rationale } : {}) }));
  const authorizedSet = new Set(deps.registry.filterAuthorized(requestedRoutes.map((route) => route.agent), ctx.identity.roles, ctx.environment));
  const authorizedRoutes = requestedRoutes.filter((route) => authorizedSet.has(route.agent));
  const authorizedAgents = authorizedRoutes.map((route) => route.agent);
  // recorded whether or not anything survived: a selection the caller may not
  // have is the single most useful thing this trace can show
  trace.refused = requestedRoutes.filter((route) => !authorizedSet.has(route.agent)).map((route) => ({ agent: route.agent, reason: "AUTHZ_DENIED" }));
  if (authorizedRoutes.length === 0) return authorizationDenied(ctx.requestId);

  const settled = await withSpan("manager.fanout", { "request.id": ctx.requestId, "agent.count": authorizedRoutes.length }, () => Promise.allSettled(
    authorizedRoutes.map((route) => executeAgent(route.agent, ctx, deps, signal, undefined, route.task)),
  ));
  const results: SpecialistResult[] = settled.map((item, index): SpecialistResult => item.status === "fulfilled" ? item.value : specialistFailure(authorizedAgents[index] as string, ctx, item.reason));

  const followup = await withSpan("round2.resolve", { "request.id": ctx.requestId, "round.number": 2 }, async () => planFollowup({
    results,
    alreadyRun: authorizedAgents,
    ctx,
    registry: deps.registry,
    entities,
    budgetUsed: false,
    maxAgentsPerRequest: deps.manager.spec.execution.maxAgentsPerRequest,
    allowedManagerAgents: deps.manager.spec.agents.allowed,
  }));
  const rejectionEvidence = followupRejectionEvidence(followup.rejections, ctx);
  if (rejectionEvidence.length > 0 && results[0] !== undefined) results[0].evidence.push(...rejectionEvidence);
  if (followup.request !== undefined) {
    incrementMetric("sre_round2_total");
    const request = followup.request;
    trace.followup = { agent: request.agentId, reason: request.handoff.reasonCode };
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

/**
 * Why routing failed, not merely that it did.
 *
 * Everything used to collapse into ROUTE_INVALID, so a prompt regression, a
 * hallucinated agent, an agent this environment does not deploy and the model
 * provider being down were one code on the console. They have different fixes
 * and only one of them is worth retrying.
 *
 * The MESSAGE stays generic for every case. The code is the diagnostic, and it
 * names nothing a caller could not already read off the console's front page.
 */
const ROUTING_FAILURES: Record<string, { message: string; retryable: boolean }> = {
  MANAGER_OUTPUT_INVALID: { message: "The Manager returned an unusable routing decision", retryable: true },
  UNKNOWN_AGENT: { message: "Routing named a specialist that does not exist", retryable: false },
  DISABLED_AGENT: { message: "Routing named a specialist this environment does not run", retryable: false },
  MODEL_UNAVAILABLE: { message: "The routing model is unavailable", retryable: true },
  MODEL_RATE_LIMITED: { message: "The routing model is rate limited", retryable: true },
  MODEL_TIMEOUT: { message: "The routing model timed out", retryable: true },
  ROUTE_INVALID: { message: "Routing failed", retryable: false },
};

function routingFailure(requestId: string, error: unknown): AssistantResponse {
  const raw = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  const code = (raw in ROUTING_FAILURES ? raw : "ROUTE_INVALID") as RuntimeErrorCode;
  const { message, retryable } = ROUTING_FAILURES[code] as { message: string; retryable: boolean };
  incrementMetric("sre_routing_failures_total");
  return {
    requestId,
    answer: "The request could not be routed safely.",
    citations: [],
    evidenceGaps: [{ source: "routing", reason: code }],
    degraded: true,
    metadata: { routedAgents: [], tierLUsed: false },
    error: { code, message, retryable },
  };
}

function noEvidence(requestId: string, authorizedAgents: string[]): AssistantResponse {
  return { requestId, answer: "The selected evidence sources were unavailable.", citations: [], evidenceGaps: authorizedAgents.map((source) => ({ source, reason: "AGENT_UNAVAILABLE" })), degraded: true, metadata: { routedAgents: authorizedAgents, tierLUsed: false } };
}
