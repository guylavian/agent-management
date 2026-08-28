import type { SpecialistExecution } from "@sre/config";
import { specialistResultSchema, type Evidence, type RuntimeError, type SpecialistResult } from "@sre/evidence";
import { redactText } from "@sre/redaction";
import type { SpecialistAction } from "../actions/control-tools.ts";
import { enforceEvidenceSetBudget } from "./normalizer.ts";

export function answerResult(agentId: string, evidence: Evidence[], errors: RuntimeError[], budget: SpecialistExecution, action: SpecialistAction): SpecialistResult {
  const normalized = enforceEvidenceSetBudget(evidence, budget);
  const known = new Set(normalized.map((item) => item.id));
  // fabricated evidence IDs are dropped; the model cannot cite evidence it did not collect
  const citedUnknown = (action.evidenceIds ?? []).filter((id) => !known.has(id));
  const augmentedErrors = citedUnknown.length > 0 ? [...errors, { code: "MODEL_INVALID_OUTPUT" as const, message: "Answer cited unknown evidence IDs", retryable: false }] : errors;
  const summary = redactText(action.summary ?? "No supported answer could be produced from the available evidence.").value;
  return specialistResultSchema.parse({ agentId, status: augmentedErrors.length === 0 ? "complete" : normalized.length > 0 ? "partial" : "failed", evidence: normalized, summary, ...(augmentedErrors.length ? { errors: augmentedErrors } : {}) });
}

export function insufficientResult(agentId: string, evidence: Evidence[], errors: RuntimeError[], budget: SpecialistExecution, reason: string): SpecialistResult {
  const normalized = enforceEvidenceSetBudget(evidence, budget);
  return specialistResultSchema.parse({ agentId, status: normalized.length > 0 ? "partial" : "failed", evidence: normalized, summary: redactText(`Insufficient evidence: ${reason}`).value, ...(errors.length ? { errors } : {}) });
}

export function failed(agentId: string, code: RuntimeError["code"], message: string): SpecialistResult {
  return { agentId, status: "failed", evidence: [], errors: [{ code, message, retryable: false }] };
}

export function failedWithEvidence(agentId: string, evidence: Evidence[], errors: RuntimeError[], budget: SpecialistExecution, code: RuntimeError["code"], message: string): SpecialistResult {
  const normalized = enforceEvidenceSetBudget(evidence, budget);
  return { agentId, status: normalized.length ? "partial" : "failed", evidence: normalized, errors: [...errors, { code, message, retryable: false }] };
}
