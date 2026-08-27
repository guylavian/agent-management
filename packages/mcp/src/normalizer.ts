import type { Evidence, EvidenceStatus } from "@sre/evidence";
import type { ToolInvocation, ToolResult } from "./toolhive-client.ts";

export function toolResultToEvidence(call: ToolInvocation, result: ToolResult, agentId: string, kind: Evidence["kind"] = "telemetry"): Evidence {
  const empty = Array.isArray(result.content) && result.content.length === 0;
  // wiki/knowledge evidence records sourceModifiedAt (doc version), not observedAt (live-state semantics)
  const isKnowledge = kind === "wiki";
  return { id: `mcp:${call.requestId}:${call.toolName}`, kind, source: `${call.serverId}/${call.toolName}`, system: call.serverId, environment: call.environment, ...(isKnowledge ? { sourceModifiedAt: result.observedAt } : { observedAt: result.observedAt }), tool: call.toolName, query: JSON.stringify(call.arguments), payload: result.content, citation: `mcp://${call.serverId}/${call.toolName}?request=${call.requestId}`, status: result.isError ? "failed" : empty ? "empty" : "ok", requestId: call.requestId, agentId };
}

export function toolFailureEvidence(call: ToolInvocation, agentId: string, code: unknown): Evidence {
  const status: EvidenceStatus = code === "TOOL_DENIED" ? "denied" : code === "MCP_TIMEOUT" || code === "REQUEST_TIMEOUT" ? "missing" : "failed";
  return { id: `mcp:${call.requestId}:${call.toolName}`, kind: "missing", source: `${call.serverId}/${call.toolName}`, system: call.serverId, environment: call.environment, observedAt: new Date().toISOString(), tool: call.toolName, query: JSON.stringify(call.arguments), citation: `mcp://${call.serverId}/${call.toolName}?request=${call.requestId}`, status, requestId: call.requestId, agentId };
}
