import type { Evidence, EvidenceStatus } from "@sre/evidence";
import type { ToolCallRequest, ToolCallResult } from "./port.ts";

/**
 * A stable fingerprint of a call's arguments, part of the evidence identity.
 *
 * The id used to be `mcp:<request>:<tool>` — the ARGUMENTS were not part of the
 * identity, so two different queries through the same tool shared one id, and
 * every dedup-by-id downstream silently dropped the second query's evidence.
 * Identity now includes what was actually asked.
 */
export function argsFingerprint(args: Record<string, unknown>): string {
  let hash = 0x811c9dc5; // FNV-1a 32-bit
  for (const char of canonicalJson(args)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** JSON with recursively sorted object keys, so property order cannot split identity. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : 1);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function evidenceIdFor(call: Pick<ToolCallRequest, "requestId" | "toolName" | "arguments">): string {
  return `mcp:${call.requestId}:${call.toolName}:${argsFingerprint(call.arguments)}`;
}

/** A tool result becomes typed, citable Evidence. Nothing else enters the record. */
export function toolResultToEvidence(call: ToolCallRequest, result: ToolCallResult, agentId: string, kind: Evidence["kind"] = "telemetry"): Evidence {
  const empty = Array.isArray(result.content) && result.content.length === 0;
  // knowledge evidence records sourceModifiedAt (document version), not observedAt (live-state semantics)
  const isKnowledge = kind === "wiki";
  return { id: evidenceIdFor(call), kind, source: `${call.serverId}/${call.toolName}`, system: call.serverId, environment: call.environment, ...(isKnowledge ? { sourceModifiedAt: result.observedAt } : { observedAt: result.observedAt }), tool: call.toolName, query: JSON.stringify(call.arguments), payload: result.content, citation: `mcp://${call.serverId}/${call.toolName}?request=${call.requestId}`, status: result.isError ? "failed" : empty ? "empty" : "ok", requestId: call.requestId, agentId };
}

/** A failed call is recorded too: absence of evidence is itself evidence, and must be citable. */
export function toolFailureEvidence(call: ToolCallRequest, agentId: string, code: unknown): Evidence {
  const status: EvidenceStatus = code === "TOOL_DENIED" ? "denied" : code === "MCP_TIMEOUT" || code === "REQUEST_TIMEOUT" ? "missing" : "failed";
  return { id: evidenceIdFor(call), kind: "missing", source: `${call.serverId}/${call.toolName}`, system: call.serverId, environment: call.environment, observedAt: new Date().toISOString(), tool: call.toolName, query: JSON.stringify(call.arguments), citation: `mcp://${call.serverId}/${call.toolName}?request=${call.requestId}`, status, requestId: call.requestId, agentId };
}

/** Evidence for a call the runtime refused before any provider was reached. */
export function toolProblemEvidence(toolName: string, requestId: string, environment: string, agentId: string, kind: "unknown-tool" | "invalid-args", serverId = "runtime"): Evidence {
  return { id: `mcp:${requestId}:${toolName}:${kind}`, kind: "missing", source: `${serverId}/${toolName}`, system: serverId, environment, tool: toolName, citation: `mcp://${serverId}/${toolName}?request=${requestId}`, status: "failed", requestId, agentId };
}
