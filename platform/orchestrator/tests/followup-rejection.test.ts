import { describe, expect, it } from "vitest";
import { MockModelClient } from "@sre/llm";
import { deterministicMultiSpecialistResponse, deterministicResponseBuilder, executeRequest, type ExecutionContext } from "../src/index.ts";
import type { Evidence, SpecialistResult } from "@sre/evidence";
import { distributedRuntime } from "./distributed-fixture.ts";

/**
 * A refused round-2 request is a finding about the ANSWER, not about whichever
 * specialist happened to settle first. It used to be pushed into results[0],
 * which misreported who was refused and lost the record entirely when no
 * specialist returned at all.
 */

const identity = { subject: "bob", groups: [], roles: ["network-read"], requestId: "req-reject" };
const ctx: ExecutionContext = { request: { question: "AD replication has a network dependency", identity }, identity, environment: "prod", intent: "diagnostic", requestId: identity.requestId, deadline: Date.now() + 5000 };

const rejection: Evidence = { id: "round2:0:active-directory", kind: "missing", source: "active-directory", system: "round2", environment: "prod", citation: "round2://active-directory", status: "denied", requestId: identity.requestId, agentId: "network-observability" };

const specialist = (agentId: string): SpecialistResult => ({
  agentId,
  status: "complete",
  summary: `${agentId} findings`,
  grounding: { grounded: true, citedUsable: 1, usableEvidence: 1 },
  evidence: [{ id: `${agentId}-e`, kind: "telemetry", source: agentId, system: agentId, environment: "prod", payload: { ok: true }, citation: `tool://${agentId}`, status: "ok", requestId: identity.requestId, agentId }],
});

describe("round-2 rejections are reported without being misattributed", () => {
  it("reports a rejection without attributing it to the first specialist's result", () => {
    const result = specialist("keycloak");
    const response = deterministicResponseBuilder(ctx, result, [rejection]);
    // the rejection reaches the answer...
    expect(response.evidenceGaps.some((gap) => gap.source === "active-directory")).toBe(true);
    // ...but the specialist's own result was not mutated to carry it
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence.every((item) => !item.id.startsWith("round2:"))).toBe(true);
  });

  it("still reports the rejection when no specialist returned anything", () => {
    const response = deterministicMultiSpecialistResponse(ctx, [], undefined, [rejection]);
    expect(response.evidenceGaps.some((gap) => gap.source === "active-directory")).toBe(true);
    // no agent is invented to carry it
    expect(response.metadata.routedAgents).toEqual([]);
  });

  it("never invents an agent that did not run", async () => {
    const model = new MockModelClient();
    model.enqueue({ content: JSON.stringify({ routes: [{ agent: "network-observability", task: "Check the path." }], confidence: 0.9, abstain: false }), usage: { promptTokens: 1, completionTokens: 1 } });
    const response = await executeRequest({ question: "network path is degraded", identity }, distributedRuntime(model));
    for (const agent of response.metadata.routedAgents) {
      expect(agent).not.toMatch(/round2|rejection/u);
    }
  });
});

describe("a plain multi-specialist answer is not reported as a synthesis failure", () => {
  it("keeps every contributor and claims no Tier-L outage that did not happen", () => {
    const response = deterministicMultiSpecialistResponse(ctx, [specialist("keycloak"), specialist("openshift")]);
    expect(response.metadata.routedAgents).toEqual(["keycloak", "openshift"]);
    expect(response.answer).toContain("keycloak findings");
    expect(response.answer).toContain("openshift findings");
    // both contributed usable evidence, so nothing is degraded and no tier-l gap is invented
    expect(response.evidenceGaps.some((gap) => gap.source === "tier-l")).toBe(false);
    expect(response.degraded).toBe(false);
  });

  it("still names the Tier-L failure when synthesis genuinely could not run", () => {
    const response = deterministicMultiSpecialistResponse(ctx, [specialist("keycloak"), specialist("openshift")], "SYNTHESIS_UNAVAILABLE");
    expect(response.evidenceGaps).toContainEqual({ source: "tier-l", reason: "SYNTHESIS_UNAVAILABLE" });
    expect(response.degraded).toBe(true);
  });
});

describe("an ungrounded answer does not ship a Sources list", () => {
  it("withholds citations when the engine reports the answer cited no usable evidence", () => {
    const ungrounded: SpecialistResult = { ...specialist("keycloak"), grounding: { grounded: false, citedUsable: 0, usableEvidence: 1 } };
    const response = deterministicResponseBuilder(ctx, ungrounded);
    expect(response.citations).toEqual([]);
    expect(response.answer).not.toContain("Sources:");
    expect(response.degraded).toBe(true);
    expect(response.evidenceGaps).toContainEqual({ source: "synthesis", reason: "UNGROUNDED_ANSWER" });
  });
});
