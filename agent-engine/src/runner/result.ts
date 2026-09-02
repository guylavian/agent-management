import { agentResultSchema, type Evidence, type EngineError, type AgentResult } from "@sre/engine-contract";
import type { AgentBudgets } from "../agent/definition.ts";
import { enforceEvidenceBudget } from "../evidence/normalize.ts";
import type { Sanitizer } from "../guardrails/sanitizer.ts";
import type { AgentAction } from "./control.ts";

/**
 * How a run ends. These live with the runner, not with evidence, because they
 * are decisions about the RUN — was the answer supported, did a budget stop it,
 * did something fail — rather than facts about a source.
 *
 * Answer and handoff paths validate the result against the schema before leaving.
 * Failure constructors deliberately skip validation (throw-free error paths): they
 * accept an error code and message directly, without schema parsing, to preserve
 * the safety guarantee that runAgent never throws.
 */
export interface ResultScope {
  agentId: string;
  sanitizer: Sanitizer;
  budgets: AgentBudgets;
}

export function answerResult(scope: ResultScope, evidence: Evidence[], errors: EngineError[], action: AgentAction): AgentResult {
  // ONLY the sanitizer/normalization section is guarded: anything it throws —
  // a ZodError from a zod-built sanitizer included — is a redaction failure.
  // The final schema parse sits OUTSIDE, so ITS ZodError still classifies as
  // invalid model output in the loop's catch.
  let normalized: Evidence[];
  let summary: string;
  try {
    normalized = enforceEvidenceBudget(scope.sanitizer, evidence, scope.budgets);
    summary = scope.sanitizer.text(action.summary ?? "No supported answer could be produced from the available evidence.").value.slice(0, 4000);
  } catch {
    return redactionFailed(scope.agentId, errors);
  }
  const knownAll = new Set(evidence.map((item) => item.id)); // PRE-budget baseline for fabrication detection
  const usableNorm = new Set(normalized.filter((item) => item.status === "ok" || item.status === "empty").map((item) => item.id));
  // fabricated evidence IDs are dropped; the model cannot cite evidence it did not collect
  const cited = action.evidenceIds ?? [];
  const citedUnknown = cited.filter((id) => !knownAll.has(id));
  const citedUsable = cited.filter((id) => usableNorm.has(id)).length;
  const augmentedErrors = citedUnknown.length > 0 ? [...errors, { code: "MODEL_INVALID_OUTPUT" as const, message: "Answer cited unknown evidence IDs", retryable: false }] : errors;
  const grounding = { grounded: citedUsable > 0, citedUsable, usableEvidence: usableNorm.size };
  return agentResultSchema.parse({ agentId: scope.agentId, status: augmentedErrors.length === 0 ? "complete" : normalized.length > 0 ? "partial" : "failed", evidence: normalized, summary, grounding, ...(augmentedErrors.length ? { errors: augmentedErrors } : {}) });
}

/** The fail-closed degradation for a throwing sanitizer: typed, evidence withheld, no internals. */
function redactionFailed(agentId: string, errors: EngineError[]): AgentResult {
  return { agentId, status: "failed", evidence: [], errors: [...errors, { code: "REDACTION_FAILURE", message: "Evidence redaction failed", retryable: false }] };
}

export function insufficientResult(scope: ResultScope, evidence: Evidence[], errors: EngineError[], reason: string): AgentResult {
  let normalized: Evidence[];
  let summary: string;
  try {
    normalized = enforceEvidenceBudget(scope.sanitizer, evidence, scope.budgets);
    summary = scope.sanitizer.text(`Insufficient evidence: ${reason}`).value.slice(0, 4000);
  } catch {
    return redactionFailed(scope.agentId, errors);
  }
  return agentResultSchema.parse({ agentId: scope.agentId, status: normalized.length > 0 ? "partial" : "failed", evidence: normalized, summary, ...(errors.length ? { errors } : {}) });
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
export function handoffResult(scope: ResultScope, evidence: Evidence[], errors: EngineError[], action: AgentAction): AgentResult {
  let normalized: Evidence[];
  let domain: string;
  let summary: string;
  try {
    normalized = enforceEvidenceBudget(scope.sanitizer, evidence, scope.budgets);
    domain = scope.sanitizer.text((action.needsDomain ?? "").trim()).value.slice(0, 100);
    summary = scope.sanitizer.text(`Another domain is required: ${action.reason ?? action.needsDomain ?? "unspecified"}`).value.slice(0, 4000);
  } catch {
    return redactionFailed(scope.agentId, errors);
  }
  if (domain === "") return insufficientResult(scope, evidence, errors, "Cross-domain request was missing a target domain.");
  return agentResultSchema.parse({ agentId: scope.agentId, status: "partial", evidence: normalized, needsHandoff: [domain], summary, ...(errors.length ? { errors } : {}) });
}

/** A failure before any evidence could be collected. Carries no detail about why policy denied it. */
export function failed(agentId: string, code: EngineError["code"], message: string): AgentResult {
  return { agentId, status: "failed", evidence: [], errors: [{ code, message, retryable: false }] };
}

/**
 * The run failed, but what was collected is still the truth. When a grounded
 * summary is supplied it is DETERMINISTIC text about the run — how it was
 * interrupted and what was gathered — never a model-authored claim, so a
 * failure cannot fabricate an answer on the way out.
 */
export function failedWithEvidence(scope: ResultScope, evidence: Evidence[], errors: EngineError[], code: EngineError["code"], message: string, groundedSummary?: string): AgentResult {
  const normalized = enforceEvidenceBudget(scope.sanitizer, evidence, scope.budgets);
  const usableEvidence = normalized.filter((item) => item.status === "ok" || item.status === "empty").length;
  return {
    agentId: scope.agentId,
    status: normalized.length ? "partial" : "failed",
    evidence: normalized,
    ...(groundedSummary !== undefined && normalized.length > 0 ? { summary: scope.sanitizer.text(groundedSummary).value.slice(0, 4000) } : {}),
    // an interrupted run is EXPLICITLY ungrounded — absence would read as "unassessed"
    grounding: { grounded: false, citedUsable: 0, usableEvidence },
    errors: [...errors, { code, message, retryable: false }],
  };
}
