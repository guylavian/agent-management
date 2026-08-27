import { AgentTransportError, MockAgentClient } from "@sre/agent-client";
import { reduceEvidence, type Evidence } from "@sre/evidence";
import { MockModelClient } from "@sre/llm";
import { describe, expect, it } from "vitest";
import { executeRequest, shouldEscalate, type ExecutionContext } from "../src/index.ts";

import { distributedRuntime } from "./distributed-fixture.ts";
const identity = { subject: "alice", groups: [], roles: ["infra-read", "network-read"], requestId: "req-cross" };
const runtime = (client = new MockAgentClient()) => distributedRuntime(new MockModelClient(), client);

describe("T4 fan-out and synthesis", () => {
  it("merges cross-domain evidence with per-source provenance and uses Tier-L", async () => {
    const response = await executeRequest({ question: "Why does the OpenShift pod show network latency?", identity }, runtime());
    expect(response.metadata.routedAgents.sort()).toEqual(["network-observability", "openshift"]);
    expect(response.metadata.tierLUsed).toBe(true);
    expect(response.citations.some((citation) => citation.evidenceId.startsWith("rag:os"))).toBe(true);
    expect(response.citations.some((citation) => citation.evidenceId.startsWith("rag:net"))).toBe(true);
  });

  it("preserves partial failure while another specialist succeeds", async () => {
    const client = new MockAgentClient();
    client.enqueue("openshift", new AgentTransportError("AGENT_UNAVAILABLE", "down", true));
    const response = await executeRequest({ question: "Why does the OpenShift pod show network latency?", identity: { ...identity, requestId: "req-partial" } }, runtime(client));
    expect(response.metadata.routedAgents).toHaveLength(2);
    expect(response.degraded).toBe(true);
    expect(response.evidenceGaps.some((gap) => gap.source.includes("openshift"))).toBe(true);
    expect(response.citations.some((citation) => citation.evidenceId.includes("query_prometheus"))).toBe(true);
  });

  it("applies the deterministic synthesis gate", () => {
    const ctx = (intent: "factual" | "diagnostic"): ExecutionContext => ({ request: { question: "state", identity }, identity, environment: "prod", intent, requestId: "req", deadline: Date.now() + 1000 });
    const evidence: Evidence = { id: "e", kind: "telemetry", source: "m", system: "s", environment: "prod", citation: "mcp://s", status: "ok", requestId: "req", agentId: "a" };
    const one = reduceEvidence([{ agentId: "a", status: "complete", evidence: [evidence], summary: "ok" }]);
    expect(shouldEscalate(ctx("factual"), one)).toBe(false);
    expect(shouldEscalate(ctx("diagnostic"), one)).toBe(true);
    const two = reduceEvidence([{ agentId: "a", status: "complete", evidence: [evidence] }, { agentId: "b", status: "complete", evidence: [{ ...evidence, id: "e2", agentId: "b" }] }]);
    expect(shouldEscalate(ctx("factual"), two)).toBe(true);
  });
});
