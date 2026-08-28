import type { SpecialistExecution } from "@sre/config";
import type { Evidence } from "@sre/evidence";
import { redactEvidence } from "@sre/redaction";

const encoder = new TextEncoder();

export function normalizeEvidence(input: Evidence, limits: SpecialistExecution): Evidence {
  const redacted = redactEvidence(input);
  const original = encoder.encode(JSON.stringify({ payload: redacted.payload, rawExcerpt: redacted.rawExcerpt })).byteLength;
  let normalized = redacted;

  if (normalized.rawExcerpt !== undefined && encoder.encode(normalized.rawExcerpt).byteLength > limits.maxRawExcerptBytes) {
    normalized = { ...normalized, rawExcerpt: headBytes(normalized.rawExcerpt, limits.maxRawExcerptBytes), truncated: true, originalSizeBytes: original };
  }
  const currentSize = encoder.encode(JSON.stringify(normalized)).byteLength;
  if (currentSize > limits.maxEvidenceBytes) {
    const preservedBudget = Math.max(0, limits.maxEvidenceBytes - encoder.encode(JSON.stringify({ ...normalized, payload: undefined, rawExcerpt: undefined })).byteLength - 64);
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

export function enforceEvidenceSetBudget(evidence: Evidence[], limits: SpecialistExecution): Evidence[] {
  const result: Evidence[] = [];
  let bytes = 0;
  const tokenByteLimit = limits.maxContextTokens * 4;
  const totalLimit = Math.min(limits.maxEvidenceBytes, tokenByteLimit);
  for (const item of evidence.slice(0, limits.maxEvidenceItems)) {
    let normalized = normalizeEvidence(item, limits);
    const itemBytes = encoder.encode(JSON.stringify(normalized)).byteLength;
    if (bytes + itemBytes > totalLimit) {
      const remaining = Math.max(0, totalLimit - bytes);
      normalized = normalizeEvidence({ ...normalized, payload: undefined, rawExcerpt: headBytes(normalized.rawExcerpt ?? JSON.stringify(normalized.payload ?? ""), remaining) }, { ...limits, maxEvidenceBytes: Math.max(4096, remaining) });
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
