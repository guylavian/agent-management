import { MockAgentClient } from "@sre/agent-client";
import { MockModelClient } from "@sre/llm";
import { describe, expect, it } from "vitest";
import { executeRequest } from "../src/index.ts";

import { distributedRuntime } from "./distributed-fixture.ts";
const runtime = (model = new MockModelClient(), client = new MockAgentClient()) => distributedRuntime(model, client);

describe("T3 routing execution edge cases", () => {
  it("runs permitted top-2 alternates on abstention", async () => {
    const model = new MockModelClient();
    model.enqueue({ content: JSON.stringify({ routes: [], confidence: 0.3, abstain: true, alternates: ["active-directory", "network-observability"] }), usage: { promptTokens: 1, completionTokens: 1 } });
    const deps = runtime(model);
    const identity = { subject: "admin", groups: [], roles: ["infra-read", "network-read"], requestId: "req-fan" };
    const response = await executeRequest({ question: "certificate issue", identity }, deps);
    expect(response.metadata.routedAgents.sort()).toEqual(["active-directory", "network-observability"]);
    expect((deps.agentClient as MockAgentClient).calls.length).toBe(2);
  });

  it("clarifies with zero tool calls when abstention fan-out is not permitted", async () => {
    const model = new MockModelClient();
    model.enqueue({ content: JSON.stringify({ routes: [], confidence: 0.2, abstain: true, alternates: ["active-directory"] }), usage: { promptTokens: 1, completionTokens: 1 } });
    const deps = runtime(model);
    const response = await executeRequest({ question: "certificate issue", identity: { subject: "alice", groups: [], roles: ["infra-read"], requestId: "req-clarify" } }, deps);
    expect(response.error?.code).toBe("ROUTE_AMBIGUOUS");
    expect((deps.agentClient as MockAgentClient).calls).toHaveLength(0);
  });

  it("returns explicit authorization denial with no internals or calls", async () => {
    const deps = runtime();
    const response = await executeRequest({ question: "Check AD replication", identity: { subject: "guest", groups: [], roles: [], requestId: "req-denied" } }, deps);
    expect(response.error?.code).toBe("AUTHZ_DENIED");
    expect(response.answer).not.toMatch(/requiredRoles|policy|catalog/iu);
    expect((deps.agentClient as MockAgentClient).calls).toHaveLength(0);
  });

  it("fails closed on an unknown Manager selection", async () => {
    const model = new MockModelClient();
    model.enqueue({ content: JSON.stringify({ routes: [{ agent: "unknown", task: "x" }], confidence: 1, abstain: false }), usage: { promptTokens: 1, completionTokens: 1 } });
    const deps = runtime(model);
    const response = await executeRequest({ question: "certificate issue", identity: { subject: "alice", groups: [], roles: ["infra-read"], requestId: "req-invalid" } }, deps);
    expect(response.error?.code).toBe("ROUTE_INVALID");
    expect((deps.agentClient as MockAgentClient).calls).toHaveLength(0);
  });

  it("routes an obvious narrow factual request directly without invoking the Manager", async () => {
    const model = new MockModelClient();
    model.enqueue({ content: JSON.stringify({ routes: [{ agent: "network-observability", task: "should-not-run" }], confidence: 1, abstain: false }), usage: { promptTokens: 1, completionTokens: 1 } });
    const deps = runtime(model);
    const response = await executeRequest({ question: "Show AD replication status", identity: { subject: "alice", groups: [], roles: ["infra-read"], requestId: "req-fast" } }, deps);
    // deterministic fast path selected AD directly; the enqueued Manager decision was never consumed
    expect(response.metadata.routedAgents).toEqual(["active-directory"]);
    const calls = (deps.agentClient as MockAgentClient).calls;
    expect(calls.map((call) => call.agentId)).toEqual(["active-directory"]);
    expect(calls[0]?.request.task).toContain("Show AD replication status");
  });

  it("does not let the deterministic fast path swallow a diagnostic single-domain question", async () => {
    const model = new MockModelClient();
    // Manager returns AD + network for a causal AD question; the fast path must defer to it
    model.enqueue({ content: JSON.stringify({ routes: [{ agent: "active-directory", task: "Check AD auth." }, { agent: "network-observability", task: "Check site-B path." }], confidence: 0.9, abstain: false }), usage: { promptTokens: 1, completionTokens: 1 } });
    const deps = runtime(model);
    const response = await executeRequest({ question: "Why is AD authentication failing from Site B?", identity: { subject: "admin", groups: [], roles: ["infra-read", "network-read"], requestId: "req-diag" } }, deps);
    expect(response.metadata.routedAgents.sort()).toEqual(["active-directory", "network-observability"]);
  });

  it("assigns a distinct task to each specialist in a multi-domain route", async () => {
    const model = new MockModelClient();
    model.enqueue({ content: JSON.stringify({ routes: [{ agent: "active-directory", task: "Check AD/domain-controller/authentication-side causes." }, { agent: "network-observability", task: "Check connectivity, latency, packet loss and network-path evidence." }], confidence: 0.95, abstain: false }), usage: { promptTokens: 1, completionTokens: 1 } });
    const deps = runtime(model);
    await executeRequest({ question: "Why is authentication failing across Site B?", identity: { subject: "admin", groups: [], roles: ["infra-read", "network-read"], requestId: "req-tasks" } }, deps);
    const calls = (deps.agentClient as MockAgentClient).calls;
    const tasks = new Map(calls.map((call) => [call.agentId, call.request.task]));
    expect(tasks.get("active-directory")).toContain("authentication-side");
    expect(tasks.get("network-observability")).toContain("packet loss");
    expect(tasks.get("active-directory")).not.toEqual(tasks.get("network-observability"));
    // every selected specialist also received the original question
    expect(calls.every((call) => call.request.question.length > 0)).toBe(true);
  });
});
