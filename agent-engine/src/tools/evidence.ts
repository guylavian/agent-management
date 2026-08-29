import type { Evidence, EvidenceStatus } from "@sre/evidence";
import type { ToolCallRequest, ToolCallResult } from "./port.ts";

/** A tool result becomes typed, citable Evidence. Nothing else enters the record. */
export function toolResultToEvidence(call: ToolCallRequest, result: ToolCallResult, agentId: string, kind: Evidence["kind"] = "telemetry"): Evidence {
  const empty = Array.isArray(result.content) && result.content.length === 0;
  // knowledge evidence records sourceModifiedAt (document version), not observedAt (live-state semantics)
  const isKnowledge = kind === "wiki";
  return { id: `mcp:${call.requestId}:${call.toolName}`, kind, source: `${call.serverId}/${call.toolName}`, system: call.serverId, environment: call.environment, ...(isKnowledge ? { sourceModifiedAt: result.observedAt } : { observedAt: result.observedAt }), tool: call.toolName, query: JSON.stringify(call.arguments), payload: result.content, citation: `mcp://${call.serverId}/${call.toolName}?request=${call.requestId}`, status: result.isError ? "failed" : empty ? "empty" : "ok", requestId: call.requestId, agentId };
}

/** A failed call is recorded too: absence of evidence is itself evidence, and must be citable. */
export function toolFailureEvidence(call: ToolCallRequest, agentId: string, code: unknown): Evidence {
  const status: EvidenceStatus = code === "TOOL_DENIED" ? "denied" : code === "MCP_TIMEOUT" || code === "REQUEST_TIMEOUT" ? "missing" : "failed";
  return { id: `mcp:${call.requestId}:${call.toolName}`, kind: "missing", source: `${call.serverId}/${call.toolName}`, system: call.serverId, environment: call.environment, observedAt: new Date().toISOString(), tool: call.toolName, query: JSON.stringify(call.arguments), citation: `mcp://${call.serverId}/${call.toolName}?request=${call.requestId}`, status, requestId: call.requestId, agentId };
}

/** Evidence for a call the runtime refused before any provider was reached. */
export function toolProblemEvidence(toolName: string, requestId: string, environment: string, agentId: string, kind: "unknown-tool" | "invalid-args", serverId = "runtime"): Evidence {
  return { id: `mcp:${requestId}:${toolName}:${kind}`, kind: "missing", source: `${serverId}/${toolName}`, system: serverId, environment, tool: toolName, citation: `mcp://${serverId}/${toolName}?request=${requestId}`, status: "failed", requestId, agentId };
}
