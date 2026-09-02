import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockModelClient } from "@sre/llm";
import { describe, expect, it } from "vitest";
import { exportHumanReviewJsonl, MockGrader, TierLJudgeGrader } from "../graders/index.ts";

const input = { question: "Is it healthy?", answer: "The source reports a healthy state.", evidence: [{ id: "e1", kind: "telemetry" as const, source: "monitor", system: "service", environment: "prod", citation: "tool://monitor", status: "ok" as const, requestId: "req" }] };

describe("evaluation graders", () => {
  it("supports deterministic mock and Tier-L judge implementations", async () => {
    expect((await new MockGrader().grade(input)).unsupportedClaimRate).toBe(0);
    expect((await new TierLJudgeGrader(new MockModelClient()).grade(input)).unsupportedClaimRate).toBe(0);
  });

  it("exports JSONL for human review", async () => {
    const grade = await new MockGrader().grade(input);
    const path = join(tmpdir(), `sre-human-review-${process.pid}.jsonl`);
    exportHumanReviewJsonl(path, [{ caseId: "E01", run: 1, input, automatedGrade: grade, requiresReviewReason: "20-percent-sample" }]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ caseId: "E01", automatedGrade: { unsupportedClaimRate: 0 } });
  });
});
