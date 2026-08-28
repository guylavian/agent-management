import { describe, expect, it } from "vitest";
import type { Evidence } from "@sre/evidence";
import { redactText } from "@sre/redaction";
import { enforceEvidenceSetBudget, normalizeEvidence } from "../src/index.ts";

const base: Evidence = { id: "e1", kind: "telemetry", source: "tool", system: "ad", environment: "prod", rawExcerpt: "x".repeat(5000), citation: "mcp://ad/tool", status: "ok", requestId: "req" };
const limits = { maxToolCalls: 1, maxModelTurns: 1, timeoutMs: 1000, maxEvidenceBytes: 4096, maxContextTokens: 1000, maxEvidenceItems: 2, maxRawExcerptBytes: 512 };

describe("evidence boundary", () => {
  it("redacts before deterministic head-biased truncation", () => {
    const item = normalizeEvidence({ ...base, rawExcerpt: `password=hunter2 ${base.rawExcerpt}` }, limits);
    expect(item.rawExcerpt).toContain("[REDACTED:password]");
    expect(item.rawExcerpt).toContain("[TRUNCATED]");
    expect(item.truncated).toBe(true);
    expect(item.originalSizeBytes).toBeGreaterThan(5000);
    expect(item.citation).toBe(base.citation);
  });

  it("enforces evidence-item and context token bounds", () => {
    const output = enforceEvidenceSetBudget([base, { ...base, id: "e2" }, { ...base, id: "e3" }], limits);
    expect(output.length).toBeLessThanOrEqual(2);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(Math.min(limits.maxEvidenceBytes, limits.maxContextTokens * 4));
  });

  it("redacts bearer tokens", () => {
    expect(redactText("Bearer abcdefghijklmnopqrstuvwxyz").value).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});
