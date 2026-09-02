import type { Evidence, RuntimeError } from "@sre/evidence";
import type { ToolCredential } from "../agent/principal.ts";
import { errorCode, isTransient, safeToolMessage, toolFailureCode } from "../errors/index.ts";
import { withDeadline } from "../guardrails/deadline.ts";
import { requireCredentialFor, type CredentialScope } from "../lifecycle/credentials.ts";
import { toolFailureEvidence, toolResultToEvidence } from "./evidence.ts";
import type { ToolCallRequest, ToolPolicy, ToolProvider, VisibleTool } from "./port.ts";
import { invokeVisibleTool } from "./visibility.ts";

/** Everything one bounded tool execution needs. Assembled once per run by the runner. */
export interface ToolExecutionScope extends CredentialScope {
  policy: ToolPolicy;
  tools: ToolProvider;
  environment: string;
  signal?: AbortSignal;
  /** per-run credential map; never outlives the run */
  credentialCache: Map<string, ToolCredential>;
}

/**
 * One tool call, bounded on every axis: the per-tool timeout, the run's absolute
 * deadline (whichever is sooner), the caller's cancellation signal, and the
 * retry policy the catalog declared. A failure always produces Evidence — the
 * record of what could NOT be established is part of the answer.
 */
export async function executeTool(scope: ToolExecutionScope, selected: VisibleTool, args: Record<string, unknown>): Promise<{ evidence: Evidence; error?: RuntimeError }> {
  const server = selected.approved.serverId;
  const request = (credential?: ToolCredential): ToolCallRequest => ({
    serverId: server,
    toolName: selected.schema.name,
    arguments: args,
    environment: scope.environment,
    requestId: scope.requestId,
    principal: scope.principal,
    ...(credential ? { credential } : {}),
    timeoutMs: Math.min(selected.approved.timeoutMs, Math.max(1, scope.deadline - Date.now())),
  });

  let credential = scope.credentialCache.get(server);
  if (credential === undefined && scope.exchanger !== undefined) {
    try {
      credential = await requireCredentialFor(scope, server);
      scope.credentialCache.set(server, credential);
    } catch (error) {
      // a credential that cannot be obtained is a TOOL failure, reported in the
      // tool taxonomy. Letting it escape would surface a denial as a model error
      // and lose the evidence that this source could not be reached.
      return failure(request(), scope.agent.id, errorCode(error));
    }
  }

  const call = request(credential);
  const maxAttempts = selected.approved.retryPolicy === "transient-once" ? 2 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      scope.telemetry.counter("tool.calls");
      const result = await scope.telemetry.span(`tool.call.${call.serverId}.${call.toolName}`, {
        "request.id": scope.requestId,
        "agent.id": scope.agent.id,
        "workload.client_id": scope.agent.workload?.clientId ?? "none",
        "tool.server": call.serverId,
        "tool.name": call.toolName,
        "token.audience": credential?.audience ?? "none",
        environment: scope.environment,
      }, () => withDeadline(
        Math.min(scope.deadline, Date.now() + call.timeoutMs),
        (signal) => invokeVisibleTool(scope.agent, scope.policy, scope.tools, { ...call, signal }),
        scope.signal,
      ));
      const evidence = toolResultToEvidence(call, result, scope.agent.id, selected.approved.evidenceKind);
      if (result.isError === true) {
        return { evidence, error: { code: "TOOL_FAILED", message: safeToolMessage("TOOL_FAILED"), retryable: isTransient("TOOL_FAILED") } };
      }
      return { evidence };
    } catch (error) {
      lastError = error;
      // an expired RUN deadline is never "transient": retrying against a spent
      // budget only delays the honest answer (the per-tool timeout may retry)
      if (attempt + 1 >= maxAttempts || !isTransient(errorCode(error)) || Date.now() >= scope.deadline) break;
    }
  }
  return failure(call, scope.agent.id, errorCode(lastError));
}

function failure(call: ToolCallRequest, agentId: string, code: string): { evidence: Evidence; error: RuntimeError } {
  return {
    evidence: toolFailureEvidence(call, agentId, code),
    error: { code: toolFailureCode(code), message: safeToolMessage(code), retryable: isTransient(code) },
  };
}
