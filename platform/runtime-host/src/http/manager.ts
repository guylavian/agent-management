import { subjectHash } from "@sre/auth";
import { executeRequest, extractEntities, type AssistantResponse, type BoundedSessionContext, type RoutingTrace } from "@sre/orchestrator";
import { MockOidcClient } from "@sre/auth";
import { runtimeErrorCodeSchema } from "@sre/evidence";
import { incrementMetric, observeInflight, withSpan } from "@sre/telemetry";
import type { Express } from "express";
import { z } from "zod";
import type { ManagerDependencies } from "../bootstrap/dependencies.ts";
import { buildRunRecord, type SpecialistResultLike } from "../management/index.ts";
import { oidcAuthenticationMiddleware } from "./oidc.ts";
import { startTimer } from "./metrics.ts";

const bodySchema = z.object({ question: z.string().min(1).max(8_000), environment: z.string().min(1).optional(), sessionId: z.string().min(1).optional() }).strict();

/**
 * Simple in-memory concurrency limiter for the manager query endpoint.
 * ponytail: synchronous semaphore with a hardcoded default. A config key should follow.
 */
class ConcurrencyLimiter {
  #current = 0;
  readonly #max: number;

  constructor(maxConcurrency: number) {
    this.#max = maxConcurrency;
  }

  canProceed(): boolean {
    if (this.#current < this.#max) {
      this.#current++;
      return true;
    }
    return false;
  }

  release(): void {
    this.#current--;
  }
}

/**
 * Records the run for the management Runs view. Best-effort and never allowed
 * to affect the response: a management-plane bookkeeping failure must not turn
 * a successful investigation into an error.
 */
function recordRun(deps: ManagerDependencies, input: { requestId: string; identity: { subject: string }; environment: string; startedAt: Date; result: AssistantResponse; specialistResults: SpecialistResultLike[]; routing?: RoutingTrace }): void {
  try {
    const specialists = deps.desiredState.current().registry;
    deps.runs.record(buildRunRecord({
      requestId: input.requestId,
      userSubjectHash: subjectHash(input.identity.subject),
      environment: input.environment,
      startedAt: input.startedAt,
      durationMs: Date.now() - input.startedAt.getTime(),
      routedAgents: input.result.metadata.routedAgents,
      results: input.specialistResults,
      workloadFor: (agentId) => specialists.getSpecialist(agentId)?.spec.identity.clientId,
      modelProfileFor: (agentId) => specialists.getSpecialist(agentId)?.spec.model.profile,
      status: input.result.error ? "failed" : input.result.degraded ? "partial" : "complete",
      evidenceCount: input.result.citations.length,
      synthesized: input.result.metadata.tierLUsed,
      ...(input.routing ? { routing: input.routing } : {}),
      ...(outcomeReason(input.result) ? { outcomeReason: outcomeReason(input.result) as string } : {}),
    }));
  } catch (error) {
    // the run history is observability, not the answer; make failures observable
    incrementMetric("sre_run_record_failures_total");
    console.error(`failed to record run ${input.requestId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Why the run ended as it did, in the taxonomy's own words.
 *
 * A degraded answer is the case operators actually chase, and "degraded: true"
 * on its own sends them to the logs. The gap reasons already name the cause —
 * a rate-limited model, an unreachable MCP, a refused route — so the trace can
 * say it. These are error codes and source names, never provider detail.
 */
function outcomeReason(result: AssistantResponse): string | undefined {
  if (result.error !== undefined) return `${result.error.code}: ${result.error.message}`;
  if (!result.degraded) return undefined;
  const gaps = result.evidenceGaps.map((gap) => `${gap.source}: ${gap.reason}`);
  // no gap recorded is not the same as no reason: the specialists' own outcomes
  // still explain it, so leave this undefined and let the trace derive it there
  return gaps.length === 0 ? undefined : `degraded — ${gaps.join("; ")}`;
}


export function registerManagerRoutes(app: Express, deps: ManagerDependencies): void {
  if (deps.config.env === "local" && deps.oidc instanceof MockOidcClient) {
    const mockOidc = deps.oidc;
    app.post("/dev/token/:user", (request, response) => {
      const parsed = z.object({ user: z.enum(["alice", "bob"]) }).safeParse(request.params);
      if (!parsed.success) { response.status(404).json({ code: "AUTHN_FAILED", message: "Unknown mock user" }); return; }
      void mockOidc.issueTestToken(parsed.data.user).then((token) => response.json({ token }));
    });
  }

  const limiter = new ConcurrencyLimiter(deps.config.maxConcurrentQueries);

  app.post("/v1/query", oidcAuthenticationMiddleware(deps.oidc), async (request, response) => {
    // check concurrency limit before proceeding
    if (!limiter.canProceed()) {
      response.status(429).set("Retry-After", "1").json({ requestId: request.requestId, code: "RATE_LIMITED" as const, message: "Too many concurrent requests" });
      return;
    }
    const requestId = request.requestId;
    const bodyResult = bodySchema.safeParse(request.body);
    if (!bodyResult.success) { response.status(400).json({ requestId, code: "TOOL_INVALID_CALL", message: "Invalid request body" }); limiter.release(); return; }
    const authenticated = request.identity;
    if (authenticated === undefined) { response.status(401).json({ requestId, code: "AUTHN_FAILED", message: "Authentication failed" }); limiter.release(); return; }
    observeInflight(1);
    const endTimer = startTimer("sre_request_duration_seconds");
    const abort = new AbortController();
    request.on("close", () => { if (!response.writableEnded) abort.abort(); });
    try {
      const identity = { ...authenticated, ...(bodyResult.data.sessionId ? { sessionId: bodyResult.data.sessionId } : {}) };
      incrementMetric("sre_requests_total");
      // bounded follow-up context (SDD §14): entities + previous request ID only, keyed by user + session
      const session = bodyResult.data.sessionId === undefined ? undefined : await deps.sessionStore.get(authenticated.subject, bodyResult.data.sessionId);
      const resolvedEntities = session === undefined || session.entities.length === 0 ? undefined : Object.fromEntries(session.entities.map((entity) => [entity.alias, entity.canonical]));
      const conversation = resolvedEntities === undefined ? undefined : { resolvedEntities, ...(session?.previousRequestId ? { previousRequestId: session.previousRequestId } : {}) };
      const environment = bodyResult.data.environment ?? deps.config.defaultEnvironment;
      const startedAt = new Date();
      let specialistResults: SpecialistResultLike[] = [];
      let routing: RoutingTrace | undefined;
      const result = await withSpan("sre.query", { "request.id": requestId, "user.subject_hash": subjectHash(identity.subject), environment }, () => executeRequest(
        { question: bodyResult.data.question, environment: bodyResult.data.environment, identity, ...(conversation ? { conversation } : {}) },
        {
          // the LIVE Manager document, not the copy loaded at boot. `deps.agent`
          // is what this process started as; the console edits and displays the
          // document on disk, and two different answers to "what are the
          // Manager's limits" is exactly the divergence this work removes.
          manager: deps.desiredState.current().registry.manager,
          registry: deps.registry,
          agentClient: deps.agentClient,
          identityIssuer: deps.identityIssuer,
          model: deps.model,
          synthesisModel: deps.synthesisModel,
          requestDeadlineMs: deps.config.requestDeadlineMs,
          defaultEnvironment: deps.config.defaultEnvironment,
          onResults: (results) => { specialistResults = results as SpecialistResultLike[]; },
          onRouting: (trace) => { routing = trace; },
        },
      ));
      recordRun(deps, { requestId, identity, environment, startedAt, result, specialistResults, ...(routing ? { routing } : {}) });
      response.status(result.error?.code === "AUTHZ_DENIED" ? 403 : result.error?.code === "ROUTE_INVALID" ? 422 : 200).json(result);
      // persist session best-effort AFTER responding; a storage failure must not throw away a successful answer
      if (bodyResult.data.sessionId !== undefined) {
        void deps.sessionStore.put(mergeSessionEntities(session, authenticated.subject, bodyResult.data.sessionId, bodyResult.data.question, requestId))
          .catch((error) => {
            incrementMetric("sre_session_store_failures_total");
            console.error(`failed to persist session for ${authenticated.subject}: ${error instanceof Error ? error.message : String(error)}`);
          });
      }
    } catch (error) {
      // an unexpected internal error; not REQUEST_TIMEOUT (which is only for deadline exhaustion)
      // a driver's ECONNREFUSED or a Postgres SQLSTATE is not a code this API
      // speaks; anything outside the taxonomy is reported as what it is
      const thrown = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      const errorCode = runtimeErrorCodeSchema.safeParse(thrown).success ? thrown : "AGENT_EXECUTION_FAILED";
      response.status(500).json({ requestId, code: errorCode, message: "Request processing failed" });
    } finally {
      limiter.release();
      endTimer();
      observeInflight(-1);
    }
  });
}


function mergeSessionEntities(session: BoundedSessionContext | undefined, subject: string, sessionId: string, question: string, requestId: string): BoundedSessionContext {
  const merged = new Map((session?.entities ?? []).map((entity) => [entity.alias, entity]));
  for (const [type, value] of Object.entries(extractEntities(question))) merged.set(value, { alias: value, canonical: value, type });
  return {
    sessionId,
    subject,
    entities: [...merged.values()].slice(0, 32),
    previousRequestId: requestId,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

