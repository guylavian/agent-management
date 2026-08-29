import type { Evidence } from "@sre/evidence";

export interface GradeInput { question: string; answer: string; evidence: Evidence[] }
export interface ClaimGrade { claim: string; supported: boolean; supportingEvidenceIds: string[]; reasonCode: string }
export interface GradeResult { claims: ClaimGrade[]; unsupportedClaimRate: number }

export interface Grader {
  readonly kind: "mock" | "tier-l-judge";
  grade(input: GradeInput): Promise<GradeResult>;
}
