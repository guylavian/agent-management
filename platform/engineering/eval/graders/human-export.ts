import { writeFileSync } from "node:fs";
import type { GradeInput, GradeResult } from "./grader.ts";

export interface HumanReviewRecord { caseId: string; run: number; input: GradeInput; automatedGrade: GradeResult; requiresReviewReason: string }

export function exportHumanReviewJsonl(path: string, records: HumanReviewRecord[]): void {
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}
