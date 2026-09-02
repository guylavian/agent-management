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
});
