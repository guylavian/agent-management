import type { Evidence } from "@sre/evidence";
import type { AgentBudgets } from "../agent/definition.ts";
import type { Sanitizer } from "../guardrails/sanitizer.ts";

/**
 * THE REDACTION AND SIZE BOUNDARY.
 *
 * Everything untrusted passes through here before it reaches model context or a
 * returned result, in this order: redact, then truncate. Redacting first matters
 * — truncating a secret does not make it safe, and a secret split across a
 * truncation point would defeat pattern matching on the tail.
 *
 * The budgets are per-run configuration, not constants, so a host tunes them per
 * Agent without the engine growing a policy of its own.
 */
const encoder = new TextEncoder();

export function normalizeEvidence(sanitizer: Sanitizer, input: Evidence, budgets: AgentBudgets): Evidence {
  const redacted = sanitizer.evidence(input);
  const original = encoder.encode(JSON.stringify({ payload: redacted.payload, rawExcerpt: redacted.rawExcerpt })).byteLength;
  let normalized = redacted;

  if (normalized.rawExcerpt !== undefined && encoder.encode(normalized.rawExcerpt).byteLength > budgets.maxRawExcerptBytes) {
    normalized = { ...normalized, rawExcerpt: headBytes(normalized.rawExcerpt, budgets.maxRawExcerptBytes), truncated: true, originalSizeBytes: original };
  }
  const currentSize = encoder.encode(JSON.stringify(normalized)).byteLength;
  if (currentSize > budgets.maxEvidenceBytes) {
    const preservedBudget = Math.max(0, budgets.maxEvidenceBytes - encoder.encode(JSON.stringify({ ...normalized, payload: undefined, rawExcerpt: undefined })).byteLength - 64);
    const source = normalized.rawExcerpt ?? JSON.stringify(normalized.payload ?? "");
    normalized = {
      ...normalized,
      payload: undefined,
      rawExcerpt: headBytes(source, preservedBudget),
      truncated: true,
      originalSizeBytes: original,
    };
  }
  return normalized;
}

/**
 * Bound the whole evidence set: item count, per-item bytes, and a total capped
 * by both the byte budget and the context-token budget, so a set that fits
 * individually cannot overflow collectively.
 */
/**
 * Collapse duplicate ids to one entry, keeping the FIRST position for citation
 * stability but preferring a usable observation over a failed one: a call that
 * failed and then succeeded is one fact with its best-known state, not two.
 */
export function dedupeEvidence(evidence: Evidence[]): Evidence[] {
  const byId = new Map<string, Evidence>();
  const order: string[] = [];
  const usable = (item: Evidence) => item.status === "ok" || item.status === "empty";
  for (const item of evidence) {
    const existing = byId.get(item.id);
    if (existing === undefined) { byId.set(item.id, item); order.push(item.id); continue; }
    if (usable(existing) && !usable(item)) continue;
    byId.set(item.id, item);
  }
  return order.map((id) => byId.get(id) as Evidence);
}

export function enforceEvidenceBudget(sanitizer: Sanitizer, rawEvidence: Evidence[], budgets: AgentBudgets): Evidence[] {
  const evidence = dedupeEvidence(rawEvidence);
  const result: Evidence[] = [];
  let bytes = 0;
  const tokenByteLimit = budgets.maxContextTokens * 4;
  const totalLimit = Math.min(budgets.maxEvidenceBytes, tokenByteLimit);
  for (const item of evidence.slice(0, budgets.maxEvidenceItems)) {
    let normalized = normalizeEvidence(sanitizer, item, budgets);
    const itemBytes = encoder.encode(JSON.stringify(normalized)).byteLength;
    if (bytes + itemBytes > totalLimit) {
      const remaining = Math.max(0, totalLimit - bytes);
      normalized = normalizeEvidence(sanitizer, { ...normalized, payload: undefined, rawExcerpt: headBytes(normalized.rawExcerpt ?? JSON.stringify(normalized.payload ?? ""), remaining) }, { ...budgets, maxEvidenceBytes: Math.max(4096, remaining) });
    }
    const finalBytes = encoder.encode(JSON.stringify(normalized)).byteLength;
    if (bytes + finalBytes > totalLimit) break;
    result.push(normalized);
    bytes += finalBytes;
  }
  return result;
}

function headBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "[TRUNCATED]";
  const suffix = "\n[TRUNCATED]";
  const budget = Math.max(0, maxBytes - encoder.encode(suffix).byteLength);
  let out = value;
  while (encoder.encode(out).byteLength > budget) out = out.slice(0, Math.floor(out.length * 0.9));
  while (encoder.encode(out).byteLength > budget) out = out.slice(0, -1);
  return `${out}${suffix}`;
}
