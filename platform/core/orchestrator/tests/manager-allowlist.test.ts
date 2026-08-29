import { type ManagerAgentConfig } from "@sre/config";

import { MockModelClient } from "@sre/llm";
import { describe, expect, it } from "vitest";
import { executeRequest, MockSpecialistTransport, planFollowup, type ExecutionContext } from "../src/index.ts";
import { distributedRuntime, managerAgent, serviceRegistry } from "./distributed-fixture.ts";

const identity = { subject: "alice", groups: [], roles: ["infra-read", "network-read"], requestId: "req-allow" };

/** manager that allows only active-directory, though openshift is registered and enabled */
const restrictedManager: ManagerAgentConfig = { ...managerAgent, spec: { ...managerAgent.spec, agents: { allowed: ["active-directory"] } } };

describe("manager.agents.allowed is load-bearing on every path", () => {
  it("never routes to a registered specialist that is outside the manager allowlist", async () => {
    const client = new MockSpecialistTransport();
    const deps = { ...distributedRuntime(new MockModelClient(), client), manager: restrictedManager };
    // a purely OpenShift question; openshift is enabled + registered but not allowed
    const response = await executeRequest({ question: "OpenShift pod CrashLoopBackOff in namespace payments", identity }, deps);
    expect(response.metadata.routedAgents).not.toContain("openshift");
    expect(client.calls.some((call) => call.agentId === "openshift")).toBe(false);
  });

  it("rejects a Round-2 discovered domain outside the manager allowlist", () => {
    const ctx: ExecutionContext = { request: { question: "AD replication has a network dependency", identity }, identity, environment: "prod", intent: "diagnostic", requestId: identity.requestId, deadline: Date.now() + 5000 };
    const plan = planFollowup({
      results: [{ agentId: "active-directory", status: "complete", needsDomain: ["network-observability"], evidence: [{ id: "e", kind: "telemetry", source: "ad", system: "ad", environment: "prod", citation: "mcp://ad", status: "ok", requestId: identity.requestId, agentId: "active-directory" }] }],
      alreadyRun: ["active-directory"],
      ctx,
      registry: serviceRegistry,
      entities: {},
      budgetUsed: false,
      maxAgentsPerRequest: 3,
      allowedManagerAgents: ["active-directory"],
    });
    expect(plan.request).toBeUndefined();
    expect(plan.rejections).toEqual([expect.objectContaining({ domain: "network-observability", reason: "not-in-manager-allowlist" })]);
  });
});
