import { MockAgentClient } from "@sre/agent-client";
import { MockModelClient } from "@sre/llm";
import { describe, expect, it } from "vitest";
import { executeRequest } from "../src/index.ts";

import { distributedRuntime } from "./distributed-fixture.ts";
const runtime = (model = new MockModelClient(), client = new MockAgentClient()) => distributedRuntime(model, client);

describe("T3 routing execution edge cases", () => {
  it("runs permitted top-2 alternates on abstention", async () => {
    const model = new MockModelClient();
    model.enqueue({ content: JSON.stringify({ agents: [], confidence: 0.3, abstain: true, alternates: ["active-directory", "network-observability"] }), usage: { promptTokens: 1, completionTokens: 1 } });
    const deps = runtime(model);
    const identity = { subject: "admin", groups: [], roles: ["infra-read", "network-read"], requestId: "req-fan" };
    const response = await executeRequest({ question: "certificate issue", identity }, deps);
    expect(response.metadata.routedAgents.sort()).toEqual(["active-directory", "network-observability"]);
    expect((deps.agentClient as MockAgentClient).calls.length).toBe(2);
  });

  it("clarifies with zero tool calls when abstention fan-out is not permitted", async () => {
    const model = new MockModelClient();
    model.enqueue({ content: JSON.stringify({ agents: [], confidence: 0.2, abstain: true, alternates: ["active-directory"] }), usage: { promptTokens: 1, completionTokens: 1 } });
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
    model.enqueue({ content: JSON.stringify({ agents: ["unknown"], confidence: 1, abstain: false }), usage: { promptTokens: 1, completionTokens: 1 } });
    const deps = runtime(model);
    const response = await executeRequest({ question: "certificate issue", identity: { subject: "alice", groups: [], roles: ["infra-read"], requestId: "req-invalid" } }, deps);
    expect(response.error?.code).toBe("ROUTE_INVALID");
    expect((deps.agentClient as MockAgentClient).calls).toHaveLength(0);
  });
});
