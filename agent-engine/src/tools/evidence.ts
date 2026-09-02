import { createHash } from "node:crypto";
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
  const hash = createHash("sha256");
  hash.update(canonicalJson(args));
  return hash.digest("hex").slice(0, 32);
}

/** JSON with recursively sorted object keys, so property order cannot split identity. */
export function canonicalJson(value: unknown): string {
  // path-scoped cycle detection: a value on the CURRENT descent is a cycle; the
  // same object reached twice through different keys is legitimate sharing
  const path = new WeakSet<object>();
  const canonical = (val: unknown): string => {
    if (Array.isArray(val)) {
      if (path.has(val)) return "[CYCLE]";
      path.add(val);
      const out = `[${val.map(canonical).join(",")}]`;
      path.delete(val);
      return out;
    }
    if (val !== null && typeof val === "object") {
      if (path.has(val)) return "[CYCLE]";
      path.add(val);
      const entries = Object.entries(val as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : 1);
      const out = `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
      path.delete(val);
      return out;
    }
    return JSON.stringify(val) ?? "null";
  };
  return canonical(value);
}

export function evidenceIdFor(call: Pick<ToolCallRequest, "requestId" | "serverId" | "toolName" | "arguments">): string {
  const hash = createHash("sha256");
  hash.update(canonicalJson({ server: call.serverId, tool: call.toolName, args: call.arguments }));
  const hashHex = hash.digest("hex").slice(0, 32);
  return `mcp:${call.requestId}:${call.serverId}:${call.toolName}:${hashHex}`;
}

/** Make a payload JSON-safe: circular or unserializable values become a deterministic marker. */
function toJsonSafePayload(payload: unknown): unknown {
  // path-scoped, like canonicalJson: only a value on the current descent is a
  // cycle; shared non-cyclic references are preserved as data
  const path = new WeakSet<object>();
  const makeSafe = (val: unknown): unknown => {
    if (val === null || typeof val === "string" || typeof val === "number" || typeof val === "boolean") return val;
    if (Array.isArray(val)) {
      if (path.has(val)) return "[UNSERIALIZABLE_PAYLOAD]";
      path.add(val);
      const out = val.map(makeSafe);
      path.delete(val);
      return out;
    }
    if (typeof val === "object") {
      if (path.has(val)) return "[UNSERIALIZABLE_PAYLOAD]";
      path.add(val);
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(val as Record<string, unknown>)) {
        result[key] = makeSafe(value);
      }
      path.delete(val);
      return result;
    }
    // functions, symbols, undefined and other non-serializable types
    return "[UNSERIALIZABLE_PAYLOAD]";
  };
  try {
    const safe = makeSafe(payload);
    // Verify it's actually JSON-serializable
    JSON.stringify(safe);
    return safe;
  } catch {
    return "[UNSERIALIZABLE_PAYLOAD]";
  }
}

/** A tool result becomes typed, citable Evidence. Nothing else enters the record. */
export function toolResultToEvidence(call: ToolCallRequest, result: ToolCallResult, agentId: string, kind: Evidence["kind"] = "telemetry"): Evidence {
  const empty = Array.isArray(result.content) && result.content.length === 0;
  // knowledge evidence records sourceModifiedAt (document version), not observedAt (live-state semantics)
  const isKnowledge = kind === "wiki";
  return { id: evidenceIdFor(call), kind, source: `${call.serverId}/${call.toolName}`, system: call.serverId, environment: call.environment, ...(isKnowledge ? { sourceModifiedAt: result.observedAt } : { observedAt: result.observedAt }), tool: call.toolName, query: JSON.stringify(call.arguments), payload: toJsonSafePayload(result.content), citation: `mcp://${call.serverId}/${call.toolName}?request=${call.requestId}`, status: result.isError ? "failed" : empty ? "empty" : "ok", requestId: call.requestId, agentId };
}

/** A failed call is recorded too: absence of evidence is itself evidence, and must be citable. */
export function toolFailureEvidence(call: ToolCallRequest, agentId: string, code: unknown): Evidence {
  const status: EvidenceStatus = code === "TOOL_DENIED" ? "denied" : code === "MCP_TIMEOUT" || code === "REQUEST_TIMEOUT" ? "missing" : "failed";
  return { id: evidenceIdFor(call), kind: "missing", source: `${call.serverId}/${call.toolName}`, system: call.serverId, environment: call.environment, observedAt: new Date().toISOString(), tool: call.toolName, query: JSON.stringify(call.arguments), citation: `mcp://${call.serverId}/${call.toolName}?request=${call.requestId}`, status, requestId: call.requestId, agentId };
}

/** Evidence for a call the runtime refused before any provider was reached. */
export function toolProblemEvidence(toolName: string, requestId: string, environment: string, agentId: string, kind: "unknown-tool" | "invalid-args", serverId = "runtime", args: Record<string, unknown> = {}): Evidence {
  const hash = createHash("sha256");
  hash.update(canonicalJson({ server: serverId, tool: toolName, args }));
  const hashHex = hash.digest("hex").slice(0, 32);
  return { id: `mcp:${requestId}:${serverId}:${toolName}:${hashHex}`, kind: "missing", source: `${serverId}/${toolName}`, system: serverId, environment, tool: toolName, citation: `mcp://${serverId}/${toolName}?request=${requestId}`, status: "failed", requestId, agentId };
}
