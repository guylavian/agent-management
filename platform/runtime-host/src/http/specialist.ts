import type { AgentRunContext } from "@sre/agent-engine";
import { runSpecialistInstance } from "../adapters/index.ts";
import {
  MAX_AGENT_REQUEST_BYTES,
  MAX_AGENT_RESPONSE_BYTES,
  agentExecutionRequestSchema,
  assertSerializedLimit,
} from "@sre/agent-protocol";
import { MOCK_WORKLOAD_TOKEN, withSubjectToken } from "@sre/auth";
import { redactText } from "@sre/redaction";
import { withExtractedContext } from "@sre/telemetry";
import type { Express } from "express";
import type { SpecialistDependencies } from "../bootstrap/dependencies.ts";
import { startTimer } from "./metrics.ts";

export function registerSpecialistRoutes(app: Express, deps: SpecialistDependencies): void {
  app.post("/internal/v1/execute", async (request, response) => {
    const parsed = agentExecutionRequestSchema.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ code: "AGENT_INVALID_RESPONSE", message: "Invalid agent request" }); return; }
    // continue the Manager's W3C trace context so one distributed trace covers the whole request
    await withExtractedContext(request.headers, async () => {
      // phase 1 — admission: size, workload identity, delegated user identity, deadline.
      // Failures here are authorization/timeout signals, never execution failures.
      let identity;
      try {
        assertSerializedLimit(parsed.data, MAX_AGENT_REQUEST_BYTES, "agent request");
        await verifyWorkloadIdentity(deps, request.headers.authorization, parsed.data.requestId);
        identity = await deps.identityVerifier.verify(parsed.data.identityContext, `sre-agent:${deps.agentOf().name}`, parsed.data.requestId);
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "AGENT_UNAUTHORIZED";
        const status = code === "AGENT_REQUEST_TOO_LARGE" ? 413 : code === "AGENT_TIMEOUT" ? 504 : 403;
        response.status(status).json({ code: status === 403 ? "AGENT_UNAUTHORIZED" : code, message: "Internal agent request rejected" });
        return;
      }
      const deadline = Date.parse(parsed.data.deadline);
      if (deadline <= Date.now()) { response.status(504).json({ code: "AGENT_TIMEOUT", message: "Request deadline expired" }); return; }
      // phase 2 — execution: internal failures are reported as such, not as authorization denials
      const endTimer = startTimer("sre_agent_duration_seconds");
      try {
        const abort = new AbortController();
        request.on("close", () => { if (!response.writableEnded) abort.abort(); });
        const safeQuestion = redactText(parsed.data.question).value;
        const executionContext: AgentRunContext = {
          question: safeQuestion,
          principal: identity,
          environment: parsed.data.environment,
          requestId: parsed.data.requestId,
          deadline,
          signal: abort.signal,
          ...(parsed.data.task ? { task: parsed.data.task } : {}),
          ...(parsed.data.conversationContext?.resolvedEntities ? { resolvedEntities: parsed.data.conversationContext.resolvedEntities } : {}),
        };
        // the LIVE document: enforcement reads its allowlist from this object, so a
        // boot-time copy would keep granting access Git has already narrowed
        const result = await runSpecialistInstance(deps.agentOf(), deps.catalog, executionContext, {
          model: deps.model,
          toolhive: deps.toolhive,
          // the manager-signed assertion travels with THIS request, so the tool
          // credential can name the human it was issued for rather than only
          // the agent executing on their behalf
          // the SUBJECT of the exchange is the human's own IdP token: proven
          // against a real Keycloak, an assertion the IdP did not issue cannot
          // be exchanged. `identityContext` still proves WHICH human, bound to
          // this agent and this request, and is verified above.
          ...(deps.credentialExchanger && parsed.data.subjectToken !== undefined
            ? { credentialExchanger: withSubjectToken(deps.credentialExchanger, parsed.data.subjectToken) }
            : deps.credentialExchanger ? { credentialExchanger: deps.credentialExchanger } : {}),
        }, parsed.data.handoff);
        assertSerializedLimit(result, MAX_AGENT_RESPONSE_BYTES, "agent response");
        response.status(200).json(result);
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "AGENT_EXECUTION_FAILED";
        if (code === "AGENT_RESPONSE_TOO_LARGE") response.status(502).json({ code, message: "Internal agent response rejected" });
        else if (code === "AGENT_TIMEOUT" || code === "REQUEST_TIMEOUT") response.status(504).json({ code: "AGENT_TIMEOUT", message: "Internal agent request timed out" });
        else response.status(500).json({ code: "AGENT_EXECUTION_FAILED", message: "Internal agent execution failed" });
      } finally {
        endTimer();
      }
    });
  });
}


/**
 * Every pod in the platform mounts a projected token for the SAME audience, so
 * a valid audience proves only that the caller is some agent here — a
 * specialist could present its own token and be taken for the Manager. The
 * caller's SUBJECT is therefore pinned to the Manager's service account, which
 * is the claim that actually distinguishes it.
 */
async function verifyWorkloadIdentity(deps: SpecialistDependencies, authorization: string | undefined, requestId: string): Promise<void> {
  const match = authorization?.match(/^Bearer (.+)$/u);
  if (match?.[1] === undefined) throw new Error("missing workload identity");
  if (deps.workloadOidc === undefined) {
    if (match[1] !== MOCK_WORKLOAD_TOKEN) throw new Error("invalid workload identity");
    return;
  }
  const caller = await deps.workloadOidc.verify(match[1], requestId);
  const expected = deps.expectedManagerSubject;
  if (expected !== undefined && caller.subject !== expected) throw new Error("workload identity is not the Manager");
}
