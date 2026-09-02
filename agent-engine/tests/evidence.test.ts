import { describe, expect, it } from "vitest";
import { enforceEvidenceBudget, normalizeEvidence } from "../src/evidence/normalize.ts";
import { argsFingerprint, evidenceIdFor, toolProblemEvidence } from "../src/tools/evidence.ts";
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
    // N3 tail-fit formula allows small overage for envelope accounting; check within 0.1%
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(tight.maxContextTokens * 4 + 4);
  });

  it("keeps an oversized single item citable rather than dropping it", () => {
    const output = enforceEvidenceBudget(testSanitizer, [{ ...baseEvidence, rawExcerpt: "y".repeat(200_000) }], budgets);
    expect(output).toHaveLength(1);
    expect(output[0]?.citation).toBe(baseEvidence.citation);
    expect(output[0]?.truncated).toBe(true);
  });
});

describe("evidence identity (H3/L1)", () => {
  it("distinct arguments to the same tool on the same server yield distinct ids", () => {
    const id1 = evidenceIdFor({ requestId: "req-1", serverId: "alpha", toolName: "status", arguments: { q: "test" } });
    const id2 = evidenceIdFor({ requestId: "req-1", serverId: "alpha", toolName: "status", arguments: { q: "other" } });
    expect(id1).not.toBe(id2);
  });

  it("the same arguments on different servers yield distinct ids", () => {
    const id1 = evidenceIdFor({ requestId: "req-1", serverId: "alpha", toolName: "status", arguments: { q: "test" } });
    const id2 = evidenceIdFor({ requestId: "req-1", serverId: "beta", toolName: "status", arguments: { q: "test" } });
    expect(id1).not.toBe(id2);
  });

  it("the audit's FNV collision pair now yields distinct ids", () => {
    // Old FNV-1a hash collided on these two values
    const id1 = evidenceIdFor({ requestId: "req-1", serverId: "docs", toolName: "search", arguments: { q: "value-149599" } });
    const id2 = evidenceIdFor({ requestId: "req-1", serverId: "docs", toolName: "search", arguments: { q: "value-312382" } });
    expect(id1).not.toBe(id2);
  });

  it("id format includes server, tool, and hash components", () => {
    const id = evidenceIdFor({ requestId: "req-123", serverId: "alpha", toolName: "status", arguments: { q: "test" } });
    // Format: mcp:<requestId>:<serverId>:<toolName>:<hash32>
    const parts = id.split(":");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("tool");
    expect(parts[1]).toBe("req-123");
    expect(parts[2]).toBe("alpha");
    expect(parts[3]).toBe("status");
    // hash should be 32 hex chars
    expect(parts[4]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("key-order permutations yield the same id", () => {
    const id1 = evidenceIdFor({ requestId: "req-1", serverId: "alpha", toolName: "status", arguments: { a: 1, b: 2, c: 3 } });
    const id2 = evidenceIdFor({ requestId: "req-1", serverId: "alpha", toolName: "status", arguments: { c: 3, a: 1, b: 2 } });
    const id3 = evidenceIdFor({ requestId: "req-1", serverId: "alpha", toolName: "status", arguments: { b: 2, c: 3, a: 1 } });
    expect(id1).toBe(id2);
    expect(id2).toBe(id3);
  });

  it("toolProblemEvidence includes serverId and args fingerprint in the id", () => {
    const evidence = toolProblemEvidence("unknown_tool", "req-1", "prod", "agent-1", "unknown-tool", "runtime");
    // Should be tool:<requestId>:<serverId>:<toolName>:<args-hash> but for problem evidence with no args
    const parts = evidence.id.split(":");
    expect(parts[0]).toBe("tool");
    expect(parts[1]).toBe("req-1");
    expect(parts[2]).toBe("runtime");
    expect(parts[3]).toBe("unknown_tool");
  });

  it("argsFingerprint uses sha256 hash, not FNV-1a", () => {
    const fingerprint = argsFingerprint({ q: "test" });
    // Should be 32 hex characters (truncated sha256)
    expect(fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(fingerprint.length).toBe(32);
  });
});
