
import type { Evidence } from "@sre/evidence";

import { MockModelClient, type ChatRequest, type ChatResponse, type ModelClient } from "@sre/llm";
import { describe, expect, it } from "vitest";
import { AgentTransportError } from "@sre/agent-protocol";
import { executeRequest, MockSpecialistTransport, reduceEvidence, shouldEscalate, type ExecutionContext } from "../src/index.ts";

import { distributedRuntime } from "./distributed-fixture.ts";
const identity = { subject: "alice", groups: [], roles: ["infra-read", "network-read"], requestId: "req-cross" };
const runtime = (client = new MockSpecialistTransport()) => distributedRuntime(new MockModelClient(), client);

class ThrowingSynthesisModel implements ModelClient {
  readonly mode = "mock" as const;
  readonly #code?: string;
  constructor(code?: string) { this.#code = code; }
  async chat(_request: ChatRequest): Promise<ChatResponse> {
    throw this.#code === undefined ? new Error("tier-l down") : Object.assign(new Error("tier-l failed"), { code: this.#code });
  }
}

const withFailingSynthesis = (code: string | undefined, client = new MockSpecialistTransport()) => ({ ...distributedRuntime(new MockModelClient(), client), synthesisModel: new ThrowingSynthesisModel(code) });
const crossDomain = "Why does the OpenShift pod show network latency?";

describe("T4 fan-out and synthesis", () => {
  it("merges cross-domain evidence with per-source provenance and uses Tier-L", async () => {
    const response = await executeRequest({ question: "Why does the OpenShift pod show network latency?", identity }, runtime());
    expect(response.metadata.routedAgents.sort()).toEqual(["network-observability", "openshift"]);
    expect(response.metadata.tierLUsed).toBe(true);
    expect(response.citations.some((citation) => citation.evidenceId.startsWith("rag:os"))).toBe(true);
    expect(response.citations.some((citation) => citation.evidenceId.startsWith("rag:net"))).toBe(true);
  });

  it("preserves partial failure while another specialist succeeds", async () => {
    const client = new MockSpecialistTransport();
    client.enqueue("openshift", new AgentTransportError("AGENT_UNAVAILABLE", "down", true));
    const response = await executeRequest({ question: "Why does the OpenShift pod show network latency?", identity: { ...identity, requestId: "req-partial" } }, runtime(client));
    expect(response.metadata.routedAgents).toHaveLength(2);
    expect(response.degraded).toBe(true);
    expect(response.evidenceGaps.some((gap) => gap.source.includes("openshift"))).toBe(true);
    expect(response.citations.some((citation) => citation.evidenceId.startsWith("tool:net"))).toBe(true);
  });

  it.each([
    ["REQUEST_TIMEOUT", "MODEL_TIMEOUT"],
    ["MODEL_INVALID_OUTPUT", "MODEL_INVALID_OUTPUT"],
    [undefined, "MODEL_UNAVAILABLE"],
  ])("falls back to all specialist summaries when Tier-L fails (%s)", async (thrownCode, expectedReason) => {
    const response = await executeRequest({ question: crossDomain, identity: { ...identity, requestId: `req-tl-${expectedReason}` } }, withFailingSynthesis(thrownCode));
    expect(response.metadata.tierLUsed).toBe(false);
    expect(response.degraded).toBe(true);
    expect(response.answer).toContain("openshift:");
    expect(response.answer).toContain("network-observability:");
    expect(response.evidenceGaps).toEqual(expect.arrayContaining([{ source: "tier-l", reason: expectedReason }]));
  });

  it("keeps a failed specialist visible alongside successful ones in the fallback", async () => {
    const client = new MockSpecialistTransport();
    client.enqueue("openshift", new AgentTransportError("AGENT_UNAVAILABLE", "down", true));
    const response = await executeRequest({ question: crossDomain, identity: { ...identity, requestId: "req-mixed" } }, withFailingSynthesis("REQUEST_TIMEOUT", client));
    expect(response.metadata.routedAgents.sort()).toEqual(["network-observability", "openshift"]);
    expect(response.answer).toContain("network-observability:");
    expect(response.answer).toContain("openshift:");
    expect(response.evidenceGaps.some((gap) => gap.source.includes("openshift"))).toBe(true);
  });

  it("applies the deterministic synthesis gate", () => {
    const ctx = (intent: "factual" | "diagnostic"): ExecutionContext => ({ request: { question: "state", identity }, identity, environment: "prod", intent, requestId: "req", deadline: Date.now() + 1000 });
    const evidence: Evidence = { id: "e", kind: "telemetry", source: "m", system: "s", environment: "prod", citation: "tool://s", status: "ok", requestId: "req", agentId: "a" };
    const one = reduceEvidence([{ agentId: "a", status: "complete", evidence: [evidence], summary: "ok" }]);
    expect(shouldEscalate(ctx("factual"), one)).toBe(false);
    expect(shouldEscalate(ctx("diagnostic"), one)).toBe(true);
    const two = reduceEvidence([{ agentId: "a", status: "complete", evidence: [evidence] }, { agentId: "b", status: "complete", evidence: [{ ...evidence, id: "e2", agentId: "b" }] }]);
    expect(shouldEscalate(ctx("factual"), two)).toBe(true);
  });
});
