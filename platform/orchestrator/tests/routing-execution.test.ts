
import { MockModelClient } from "@sre/llm";
import { describe, expect, it } from "vitest";
import { executeRequest, MockSpecialistTransport } from "../src/index.ts";

import { distributedRuntime } from "./distributed-fixture.ts";
const runtime = (model = new MockModelClient(), client = new MockSpecialistTransport()) => distributedRuntime(model, client);

describe("T3 routing execution edge cases", () => {
  it("runs permitted top-2 alternates on abstention", async () => {
    const model = new MockModelClient();
    model.enqueue({ content: JSON.stringify({ routes: [], confidence: 0.3, abstain: true, alternates: ["active-directory", "network-observability"] }), usage: { promptTokens: 1, completionTokens: 1 } });
    const deps = runtime(model);
    const identity = { subject: "admin", groups: [], roles: ["infra-read", "network-read"], requestId: "req-fan" };
    const response = await executeRequest({ question: "certificate issue", identity }, deps);
    expect(response.metadata.routedAgents.sort()).toEqual(["active-directory", "network-observability"]);
    expect((deps.agentClient as MockSpecialistTransport).calls.length).toBe(2);
  });

  it("clarifies with zero tool calls when abstention fan-out is not permitted", async () => {
    const model = new MockModelClient();
    model.enqueue({ content: JSON.stringify({ routes: [], confidence: 0.2, abstain: true, alternates: ["active-directory"] }), usage: { promptTokens: 1, completionTokens: 1 } });
    const deps = runtime(model);
    const response = await executeRequest({ question: "certificate issue", identity: { subject: "alice", groups: [], roles: ["infra-read"], requestId: "req-clarify" } }, deps);
    expect(response.error?.code).toBe("ROUTE_AMBIGUOUS");
    expect((deps.agentClient as MockSpecialistTransport).calls).toHaveLength(0);
  });

  it("returns explicit authorization denial with no internals or calls", async () => {
    const deps = runtime();
    const response = await executeRequest({ question: "Check AD replication", identity: { subject: "guest", groups: [], roles: [], requestId: "req-denied" } }, deps);
    expect(response.error?.code).toBe("AUTHZ_DENIED");
    expect(response.answer).not.toMatch(/requiredRoles|policy|catalog/iu);
    expect((deps.agentClient as MockSpecialistTransport).calls).toHaveLength(0);
  });

  it("fails closed on an unknown Manager selection", async () => {
    const model = new MockModelClient();
    model.enqueue({ content: JSON.stringify({ routes: [{ agent: "unknown", task: "x" }], confidence: 1, abstain: false }), usage: { promptTokens: 1, completionTokens: 1 } });
    const deps = runtime(model);
    const response = await executeRequest({ question: "certificate issue", identity: { subject: "alice", groups: [], roles: ["infra-read"], requestId: "req-invalid" } }, deps);
    // the code survives the orchestrator rather than collapsing: a hallucinated
    // agent and a model outage had the same code, and only one is worth a retry
    expect(response.error?.code).toBe("UNKNOWN_AGENT");
    expect(response.error?.retryable).toBe(false);
    expect(response.evidenceGaps?.[0]).toMatchObject({ source: "routing", reason: "UNKNOWN_AGENT" });
    expect((deps.agentClient as MockSpecialistTransport).calls).toHaveLength(0);
  });

  /**
   * Every request reaches the Manager. A keyword stage used to answer narrow
   * factual questions before the model was asked, which meant an agent was
   * reachable only if someone had written the right phrase into its config.
   * The model now decides, and the task it writes is what the specialist gets.
   */
  it("asks the Manager even for an obvious single-domain request, and uses the task it writes", async () => {
    const model = new MockModelClient();
    model.enqueue({ content: JSON.stringify({ routes: [{ agent: "active-directory", task: "Report current AD replication status across domain controllers." }], confidence: 0.95, abstain: false }), usage: { promptTokens: 1, completionTokens: 1 } });
    const deps = runtime(model);
    const response = await executeRequest({ question: "Show AD replication status", identity: { subject: "alice", groups: [], roles: ["infra-read"], requestId: "req-single" } }, deps);

    expect(response.metadata.routedAgents).toEqual(["active-directory"]);
    const calls = (deps.agentClient as MockSpecialistTransport).calls;
    expect(calls.map((call) => call.agentId)).toEqual(["active-directory"]);
    // the specialist receives the Manager's task, not a template built from the question
    expect(calls[0]?.request.task).toContain("replication status across domain controllers");
  });

  it("routes a question whose wording matches no agent's vocabulary", async () => {
    const model = new MockModelClient();
    // nothing here says "active directory", "kerberos" or "ldap" — the old
    // keyword stage would have found nothing and the Manager decides on meaning
    model.enqueue({ content: JSON.stringify({ routes: [{ agent: "active-directory", task: "Investigate sign-in failures for the Tel Aviv office." }], confidence: 0.8, abstain: false }), usage: { promptTokens: 1, completionTokens: 1 } });
    const deps = runtime(model);
    const response = await executeRequest({ question: "Nobody in the Tel Aviv office can sign in this morning", identity: { subject: "alice", groups: [], roles: ["infra-read"], requestId: "req-semantic" } }, deps);
    expect(response.metadata.routedAgents).toEqual(["active-directory"]);
  });

  it("routes a genuinely cross-domain question to more than one specialist", async () => {
    const model = new MockModelClient();
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
    const calls = (deps.agentClient as MockSpecialistTransport).calls;
    const tasks = new Map(calls.map((call) => [call.agentId, call.request.task]));
    expect(tasks.get("active-directory")).toContain("authentication-side");
    expect(tasks.get("network-observability")).toContain("packet loss");
    expect(tasks.get("active-directory")).not.toEqual(tasks.get("network-observability"));
    // every selected specialist also received the original question
    expect(calls.every((call) => call.request.question.length > 0)).toBe(true);
  });
});
