import type { GradeInput, GradeResult, Grader } from "./grader.ts";

export class MockGrader implements Grader {
  readonly kind = "mock" as const;
  async grade(input: GradeInput): Promise<GradeResult> {
    const material = input.answer.split(/(?<=[.!?])\s+/u).filter((claim) => claim.length > 20 && !claim.startsWith("Sources:") && !claim.startsWith("Evidence gaps:"));
    const ids = input.evidence.map((item) => item.id);
    const claims = material.map((claim) => ({ claim, supported: ids.length > 0 || /clarify|not authorized|could not be routed/iu.test(claim), supportingEvidenceIds: ids, reasonCode: ids.length > 0 ? "evidence-present" : "control-response" }));
    const unsupported = claims.filter((claim) => !claim.supported).length;
    return { claims, unsupportedClaimRate: claims.length === 0 ? 0 : unsupported / claims.length };
  }
}
