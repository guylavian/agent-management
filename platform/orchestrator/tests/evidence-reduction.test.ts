import { describe, expect, it } from "vitest";
import type { SpecialistResult } from "@sre/evidence";
import { reduceEvidence } from "../src/index.ts";

describe("evidence reducer", () => {
  it("deduplicates evidence and detects same-environment state conflicts", () => {
    const results: SpecialistResult[] = [
      { agentId: "a", status: "complete", evidence: [{ id: "wiki", kind: "wiki", source: "runbook", system: "service", environment: "prod", rawExcerpt: "Service should be healthy", citation: "wiki://runbook", status: "ok", requestId: "req", agentId: "a" }] },
      { agentId: "b", status: "complete", evidence: [
        { id: "live", kind: "telemetry", source: "monitor", system: "service", environment: "prod", payload: { state: "unhealthy" }, citation: "tool://monitor", status: "ok", requestId: "req", agentId: "b" },
        { id: "live", kind: "telemetry", source: "monitor", system: "service", environment: "prod", payload: { state: "unhealthy" }, citation: "tool://monitor", status: "ok", requestId: "req", agentId: "b" },
      ] },
    ];
    const reduced = reduceEvidence(results);
    expect(reduced.evidence).toHaveLength(2);
    expect(reduced.conflicts).toEqual([{ left: "wiki", right: "live", reason: "state-mismatch" }]);
    expect(reduced.contributingAgents).toEqual(["a", "b"]);
  });

  it("prefers a usable observation over a failed one for the same id, keeping first position", () => {
    const results: SpecialistResult[] = [
      { agentId: "a", status: "partial", evidence: [{ id: "live", kind: "telemetry", source: "monitor", system: "service", environment: "prod", citation: "tool://monitor", status: "failed", requestId: "req", agentId: "a" }] },
      { agentId: "b", status: "complete", evidence: [{ id: "live", kind: "telemetry", source: "monitor", system: "service", environment: "prod", payload: { state: "healthy" }, citation: "tool://monitor", status: "ok", requestId: "req", agentId: "b" }] },
    ];
    const reduced = reduceEvidence(results);
    // one fact, its best-known state: a settled-first failure must not shadow another specialist's success
    expect(reduced.evidence).toHaveLength(1);
    expect(reduced.evidence[0]?.status).toBe("ok");
    expect(reduced.evidence[0]?.agentId).toBe("b");
  });

  it("detects state conflicts only on actual word boundaries, not substrings", () => {
    // These strings contain state-like substrings but should NOT be detected as having conflicting states
    const results: SpecialistResult[] = [
      { agentId: "a", status: "complete", evidence: [{ id: "e1", kind: "report", source: "doc", system: "service", environment: "prod", rawExcerpt: "unfailed deployment process", citation: "source://doc", status: "ok", requestId: "req", agentId: "a" }] },
      { agentId: "b", status: "complete", evidence: [{ id: "e2", kind: "report", source: "doc", system: "service", environment: "prod", rawExcerpt: "system shutdown completed", citation: "source://doc", status: "ok", requestId: "req", agentId: "b" }] },
    ];
    const reduced = reduceEvidence(results);
    // "unfailed" contains "failed", "shutdown" contains "down" — these are false positives that should not create conflicts
    expect(reduced.conflicts).toHaveLength(0);
  });

  it("detects state conflicts on words with middle-word substrings", () => {
    // These strings contain state words as substrings within other words
    const results: SpecialistResult[] = [
      { agentId: "a", status: "complete", evidence: [{ id: "e1", kind: "report", source: "doc", system: "service", environment: "prod", rawExcerpt: "service outrunning all competitors", citation: "source://doc", status: "ok", requestId: "req", agentId: "a" }] },
      { agentId: "b", status: "complete", evidence: [{ id: "e2", kind: "report", source: "doc", system: "service", environment: "prod", rawExcerpt: "service backup is unhealthy", citation: "source://doc", status: "ok", requestId: "req", agentId: "b" }] },
    ];
    const reduced = reduceEvidence(results);
    // Currently these would incorrectly match: "outrunning" contains "running" (healthy), "backup" contains "up" (healthy)
    // But "unhealthy" should detect as unhealthy
    // This should detect a conflict due to the bug, but after fix should work correctly
    expect(reduced.conflicts).toHaveLength(0);
  });

  it("detects state conflicts when actual state words are present", () => {
    const results: SpecialistResult[] = [
      { agentId: "a", status: "complete", evidence: [{ id: "e1", kind: "report", source: "doc", system: "service", environment: "prod", rawExcerpt: "service is unhealthy", citation: "source://doc", status: "ok", requestId: "req", agentId: "a" }] },
      { agentId: "b", status: "complete", evidence: [{ id: "e2", kind: "report", source: "doc", system: "service", environment: "prod", rawExcerpt: "service is healthy", citation: "source://doc", status: "ok", requestId: "req", agentId: "b" }] },
    ];
    const reduced = reduceEvidence(results);
    expect(reduced.conflicts).toHaveLength(1);
    expect(reduced.conflicts[0]).toEqual({ left: "e1", right: "e2", reason: "state-mismatch" });
  });
});
