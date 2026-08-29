import { describe, expect, it } from "vitest";
import { enforceEvidenceBudget, normalizeEvidence } from "../src/index.ts";
import { baseEvidence, BUDGETS, testSanitizer } from "./harness.ts";

const budgets = { ...BUDGETS, maxEvidenceBytes: 4096, maxContextTokens: 1000, maxEvidenceItems: 2, maxRawExcerptBytes: 512 };

describe("evidence boundary", () => {
  it("redacts BEFORE truncating, so a secret cannot survive by being cut in half", () => {
    const item = normalizeEvidence(testSanitizer, { ...baseEvidence, rawExcerpt: `password=hunter2 ${baseEvidence.rawExcerpt}` }, budgets);
    expect(item.rawExcerpt).toContain("[REDACTED:password]");
    expect(item.rawExcerpt).toContain("[TRUNCATED]");
    expect(item.truncated).toBe(true);
    expect(item.originalSizeBytes).toBeGreaterThan(5000);
    // provenance survives truncation: a truncated item is still citable
    expect(item.citation).toBe(baseEvidence.citation);
  });

  it("redacts a payload as well as an excerpt", () => {
    const item = normalizeEvidence(testSanitizer, { ...baseEvidence, rawExcerpt: undefined, payload: { note: "password=hunter2" } }, budgets);
    expect(JSON.stringify(item.payload)).toContain("[REDACTED:password]");
    expect(item.redaction?.applied).toBe(true);
  });

  it("enforces the item-count bound and the total byte bound together", () => {
    const output = enforceEvidenceBudget(testSanitizer, [baseEvidence, { ...baseEvidence, id: "e2" }, { ...baseEvidence, id: "e3" }], budgets);
    expect(output.length).toBeLessThanOrEqual(2);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(Math.min(budgets.maxEvidenceBytes, budgets.maxContextTokens * 4));
  });

  it("caps the total by the context-token budget when it is the tighter bound", () => {
    const tight = { ...budgets, maxEvidenceBytes: 1_000_000, maxContextTokens: 1_000, maxEvidenceItems: 16 };
    const many = Array.from({ length: 16 }, (_value, index) => ({ ...baseEvidence, id: `e${index}` }));
    const output = enforceEvidenceBudget(testSanitizer, many, tight);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(tight.maxContextTokens * 4);
  });

  it("keeps an oversized single item citable rather than dropping it", () => {
    const output = enforceEvidenceBudget(testSanitizer, [{ ...baseEvidence, rawExcerpt: "y".repeat(200_000) }], budgets);
    expect(output).toHaveLength(1);
    expect(output[0]?.citation).toBe(baseEvidence.citation);
    expect(output[0]?.truncated).toBe(true);
  });
});
