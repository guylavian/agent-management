import type { ToolCredential, WorkloadIdentity } from "@sre/auth";
import { audienceFor, type ApprovedCatalog, type SpecialistAgentConfig } from "@sre/config";
import type { Evidence, RuntimeError } from "@sre/evidence";
import { withSpan, incrementMetric } from "@sre/telemetry";
import { errorCode, isTransient, withDeadline } from "../limits.ts";
import type { SpecialistEngineDependencies, SpecialistExecutionContext } from "../types.ts";
import { invokeVisibleToolForSpecialist, toolFailureEvidence, toolResultToEvidence, type ToolInvocation, type VisibleTool } from "./index.ts";

/**
 * The Agent's own workload identity — distinct from the delegated human. The
 * credential presented to ToolHive carries both: the human as the subject that
 * initiated the request, the workload as the actor that executed it (TDD §13).
 */
export function workload(agent: SpecialistAgentConfig): WorkloadIdentity {
  return { clientId: agent.spec.identity.clientId, provider: agent.spec.identity.provider, agentId: agent.name };
}

export async function executeTool(
  agent: SpecialistAgentConfig,
  catalog: ApprovedCatalog,
  ctx: SpecialistExecutionContext,
  deps: SpecialistEngineDependencies,
  selected: VisibleTool,
  args: Record<string, unknown>,
  credentials: Map<string, ToolCredential>,
  deadline: number,
): Promise<{ evidence: Evidence; error?: RuntimeError }> {
  let credential = credentials.get(selected.approved.serverId);
  if (credential === undefined && deps.credentialExchanger !== undefined) {
    const audience = audienceFor(agent.spec, selected.approved.serverId);
    if (audience === undefined) throw Object.assign(new Error("Tool access denied"), { code: "TOOL_DENIED" });
    // attributes name the workload and the audience; the token itself is never recorded
    credential = await withSpan("workload.token", { "request.id": ctx.requestId, "agent.id": agent.name, "workload.client_id": agent.spec.identity.clientId, "mcp.server": selected.approved.serverId, "token.audience": audience }, () => deps.credentialExchanger?.exchange(workload(agent), ctx.identity, audience, deadline) as Promise<ToolCredential>);
    credentials.set(selected.approved.serverId, credential);
  }
  const invocation: ToolInvocation = { serverId: selected.approved.serverId, toolName: selected.schema.name, arguments: args, environment: ctx.environment, requestId: ctx.requestId, identity: ctx.identity, ...(credential ? { credential } : {}), timeoutMs: Math.min(selected.approved.timeoutMs, Math.max(1, deadline - Date.now())) };
  const maxAttempts = selected.approved.retryPolicy === "transient-once" ? 2 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      incrementMetric("sre_tool_calls_total");
      const result = await withSpan(`toolhive.call.${invocation.serverId}.${invocation.toolName}`, { "request.id": ctx.requestId, "agent.id": agent.name, "workload.client_id": agent.spec.identity.clientId, "mcp.server": invocation.serverId, "mcp.tool": invocation.toolName, "token.audience": credential?.audience ?? "none", environment: ctx.environment }, () => withDeadline(Math.min(deadline, Date.now() + invocation.timeoutMs), (signal) => invokeVisibleToolForSpecialist(catalog, deps.authorization, deps.toolhive, agent, { ...invocation, signal }), ctx.signal));
      return { evidence: toolResultToEvidence(invocation, result, agent.name, selected.approved.evidenceKind) };
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= maxAttempts || !isTransient(errorCode(error))) break;
    }
  }
  const code = errorCode(lastError);
  return {
    evidence: toolFailureEvidence(invocation, agent.name, code),
    error: { code: code === "MCP_UNAVAILABLE" ? "MCP_UNAVAILABLE" : code === "MCP_TIMEOUT" || code === "REQUEST_TIMEOUT" ? "MCP_TIMEOUT" : code === "TOOL_DENIED" ? "TOOL_DENIED" : "TOOL_FAILED", message: safeToolError(code), retryable: isTransient(code) },
  };
}

export function toolProblemEvidence(toolName: string, ctx: SpecialistExecutionContext, agentId: string, kind: "unknown-tool" | "invalid-args", serverId = "runtime"): Evidence {
  return { id: `mcp:${ctx.requestId}:${toolName}:${kind}`, kind: "missing", source: `${serverId}/${toolName}`, system: serverId, environment: ctx.environment, tool: toolName, citation: `mcp://${serverId}/${toolName}?request=${ctx.requestId}`, status: "failed", requestId: ctx.requestId, agentId };
}

function safeToolError(code: string): string {
  if (code === "TOOL_DENIED") return "A required source was not authorized";
  if (code === "MCP_TIMEOUT" || code === "REQUEST_TIMEOUT") return "A required source timed out";
  return "A required source failed";
}
