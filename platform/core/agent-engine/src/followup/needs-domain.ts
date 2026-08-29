import type { SpecialistExecution } from "@sre/config";
import { specialistResultSchema, type Evidence, type RuntimeError, type SpecialistResult } from "@sre/evidence";
import { redactText } from "@sre/redaction";
import type { SpecialistAction } from "../actions/control-tools.ts";
import { enforceEvidenceSetBudget } from "../evidence/normalizer.ts";
import { insufficientResult } from "../evidence/results.ts";

/**
 * The specialist side of cross-domain follow-up.
 *
 * A specialist may only ASK for one further domain; it never calls another
 * specialist. Whether the request is granted is decided by the Manager against
 * the discovery policy, so this returns a result, not a call.
 */
export function needsDomainResult(agentId: string, evidence: Evidence[], errors: RuntimeError[], budget: SpecialistExecution, action: SpecialistAction): SpecialistResult {
  const normalized = enforceEvidenceSetBudget(evidence, budget);
  const domain = (action.needsDomain ?? "").trim();
  if (domain === "") return insufficientResult(agentId, evidence, errors, budget, "Cross-domain request was missing a target domain.");
  return specialistResultSchema.parse({ agentId, status: normalized.length > 0 ? "partial" : "complete", evidence: normalized, needsDomain: [domain], summary: redactText(`Another domain is required: ${action.reason ?? domain}`).value, ...(errors.length ? { errors } : {}) });
}
