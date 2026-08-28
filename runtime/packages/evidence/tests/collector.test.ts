import { describe, expect, it } from "vitest";
import { reduceEvidence, type SpecialistResult } from "../src/index.ts";

describe("evidence reducer", () => {
  it("deduplicates evidence and detects same-environment state conflicts", () => {
    const results: SpecialistResult[] = [
      { agentId: "a", status: "complete", evidence: [{ id: "wiki", kind: "wiki", source: "runbook", system: "service", environment: "prod", rawExcerpt: "Service should be healthy", citation: "wiki://runbook", status: "ok", requestId: "req", agentId: "a" }] },
      { agentId: "b", status: "complete", evidence: [
        { id: "live", kind: "telemetry", source: "monitor", system: "service", environment: "prod", payload: { state: "unhealthy" }, citation: "mcp://monitor", status: "ok", requestId: "req", agentId: "b" },
        { id: "live", kind: "telemetry", source: "monitor", system: "service", environment: "prod", payload: { state: "unhealthy" }, citation: "mcp://monitor", status: "ok", requestId: "req", agentId: "b" },
      ] },
    ];
    const reduced = reduceEvidence(results);
    expect(reduced.evidence).toHaveLength(2);
    expect(reduced.conflicts).toEqual([{ left: "wiki", right: "live", reason: "state-mismatch" }]);
    expect(reduced.contributingAgents).toEqual(["a", "b"]);
  });
});
