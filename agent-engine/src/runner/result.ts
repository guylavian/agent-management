import { specialistResultSchema, type Evidence, type RuntimeError, type SpecialistResult } from "@sre/evidence";
import type { AgentBudgets } from "../agent/definition.ts";
import { enforceEvidenceBudget } from "../evidence/normalize.ts";
import type { Sanitizer } from "../guardrails/sanitizer.ts";
import type { AgentAction } from "./control.ts";

/**
 * How a run ends. These live with the runner, not with evidence, because they
 * are decisions about the RUN — was the answer supported, did a budget stop it,
 * did something fail — rather than facts about a source.
 *
 * Every path here does the same three things: bound the evidence set, redact the
 * model-authored summary, and validate the result against its schema before it
 * leaves. A result that fails validation throws rather than being returned
 * partially formed.
 */
export interface ResultScope {
  agentId: string;
  sanitizer: Sanitizer;
  budgets: AgentBudgets;
}

export function answerResult(scope: ResultScope, evidence: Evidence[], errors: RuntimeError[], action: AgentAction): SpecialistResult {
  const normalized = enforceEvidenceBudget(scope.sanitizer, evidence, scope.budgets);
  const known = new Set(normalized.map((item) => item.id));
  // fabricated evidence IDs are dropped; the model cannot cite evidence it did not collect
  const citedUnknown = (action.evidenceIds ?? []).filter((id) => !known.has(id));
  const augmentedErrors = citedUnknown.length > 0 ? [...errors, { code: "MODEL_INVALID_OUTPUT" as const, message: "Answer cited unknown evidence IDs", retryable: false }] : errors;
  const summary = scope.sanitizer.text(action.summary ?? "No supported answer could be produced from the available evidence.").value;
  return specialistResultSchema.parse({ agentId: scope.agentId, status: augmentedErrors.length === 0 ? "complete" : normalized.length > 0 ? "partial" : "failed", evidence: normalized, summary, ...(augmentedErrors.length ? { errors: augmentedErrors } : {}) });
}

export function insufficientResult(scope: ResultScope, evidence: Evidence[], errors: RuntimeError[], reason: string): SpecialistResult {
  const normalized = enforceEvidenceBudget(scope.sanitizer, evidence, scope.budgets);
  return specialistResultSchema.parse({ agentId: scope.agentId, status: normalized.length > 0 ? "partial" : "failed", evidence: normalized, summary: scope.sanitizer.text(`Insufficient evidence: ${reason}`).value, ...(errors.length ? { errors } : {}) });
}

/**
 * The strongest cross-domain signal an Agent can produce.
 *
 * It is a REQUEST, not a call: the Agent names one domain it believes is needed
 * and returns. Whether that request is granted is decided by whatever
 * orchestrates the Agent, which the engine cannot see and cannot reach. This is
 * what keeps agent-to-agent communication impossible rather than merely
 * discouraged.
 */
export function handoffResult(scope: ResultScope, evidence: Evidence[], errors: RuntimeError[], action: AgentAction): SpecialistResult {
  const normalized = enforceEvidenceBudget(scope.sanitizer, evidence, scope.budgets);
  const domain = (action.needsDomain ?? "").trim();
  if (domain === "") return insufficientResult(scope, evidence, errors, "Cross-domain request was missing a target domain.");
  return specialistResultSchema.parse({ agentId: scope.agentId, status: normalized.length > 0 ? "partial" : "complete", evidence: normalized, needsDomain: [domain], summary: scope.sanitizer.text(`Another domain is required: ${action.reason ?? domain}`).value, ...(errors.length ? { errors } : {}) });
}

/** A failure before any evidence could be collected. Carries no detail about why policy denied it. */
export function failed(agentId: string, code: RuntimeError["code"], message: string): SpecialistResult {
  return { agentId, status: "failed", evidence: [], errors: [{ code, message, retryable: false }] };
}

/**
 * The run failed, but what was collected is still the truth. When a grounded
 * summary is supplied it is DETERMINISTIC text about the run — how it was
 * interrupted and what was gathered — never a model-authored claim, so a
 * failure cannot fabricate an answer on the way out.
 */
export function failedWithEvidence(scope: ResultScope, evidence: Evidence[], errors: RuntimeError[], code: RuntimeError["code"], message: string, groundedSummary?: string): SpecialistResult {
  const normalized = enforceEvidenceBudget(scope.sanitizer, evidence, scope.budgets);
  return {
    agentId: scope.agentId,
    status: normalized.length ? "partial" : "failed",
    evidence: normalized,
    ...(groundedSummary !== undefined && normalized.length > 0 ? { summary: scope.sanitizer.text(groundedSummary).value } : {}),
    errors: [...errors, { code, message, retryable: false }],
  };
}
