import type { SpecialistResult } from "@sre/evidence";
import { MockModelClient } from "@sre/llm";
import { describe, expect, it } from "vitest";
import { executeRequest, planFollowup, type ExecutionContext } from "../src/index.ts";
import { distributedRuntime, managerAgent, serviceRegistry } from "./distributed-fixture.ts";

const identity = { subject: "alice", groups: [], roles: ["infra-read", "network-read"], requestId: "req-r2" };
const ctx: ExecutionContext = { request: { question: "AD replication has a network dependency", identity }, identity, environment: "prod", intent: "diagnostic", requestId: identity.requestId, deadline: Date.now() + 5000 };
const result = (agentId: string, needsDomain: string, secret = "hidden transcript"): SpecialistResult => ({ agentId, status: "complete", summary: secret, needsDomain: [needsDomain], evidence: [{ id: `${agentId}-e`, kind: "telemetry", source: agentId, system: agentId, environment: "prod", rawExcerpt: secret, payload: { secret }, citation: `mcp://${agentId}`, status: "ok", requestId: identity.requestId, agentId }] });

describe("T5 bounded cross-domain follow-up", () => {
  it("executes one authorized discovered domain and never recurses", async () => {
    const model = new MockModelClient();
    // the Manager picks AD; the network domain is DISCOVERED by that specialist
    // in round two, which is what this test is about
    model.enqueue({ content: JSON.stringify({ routes: [{ agent: "active-directory", task: "Check AD replication." }], confidence: 0.9, abstain: false }), usage: { promptTokens: 1, completionTokens: 1 } });
    const runtime = distributedRuntime(model);
    const response = await executeRequest({ question: "AD replication has a network dependency", identity }, runtime);
    expect(response.metadata.routedAgents).toEqual(["active-directory", "network-observability"]);
    expect(runtime.agentClient.mode).toBe("mock");
    expect(response.metadata.tierLUsed).toBe(true);
  });

  it("rejects a second discovered request after the single budget is allocated", () => {
    const plan = planFollowup({ results: [result("active-directory", "network-observability"), result("openshift", "network-observability")], alreadyRun: ["active-directory", "openshift"], ctx, registry: serviceRegistry, entities: {}, budgetUsed: false, maxAgentsPerRequest: managerAgent.spec.execution.maxAgentsPerRequest });
    expect(plan.request?.agentId).toBe("network-observability");
    expect(plan.rejections).toEqual([expect.objectContaining({ reason: "budget-exhausted" })]);
    const exhausted = planFollowup({ results: [result("active-directory", "network-observability")], alreadyRun: ["active-directory"], ctx, registry: serviceRegistry, entities: {}, budgetUsed: true, maxAgentsPerRequest: managerAgent.spec.execution.maxAgentsPerRequest });
    expect(exhausted.request).toBeUndefined();
    expect(exhausted.rejections[0]?.reason).toBe("budget-exhausted");
    const totalAgentBudget = planFollowup({ results: [result("active-directory", "network-observability")], alreadyRun: ["active-directory", "openshift", "another-agent"], ctx, registry: serviceRegistry, entities: {}, budgetUsed: false, maxAgentsPerRequest: managerAgent.spec.execution.maxAgentsPerRequest });
    expect(totalAgentBudget.rejections[0]?.reason).toBe("budget-exhausted");
  });

  it("rejects unauthorized and non-allowlisted domains", () => {
    const bob = { subject: "bob", groups: [], roles: ["network-read"], requestId: "req-bob" };
    const bobCtx = { ...ctx, identity: bob, request: { question: ctx.request.question, identity: bob }, requestId: bob.requestId };
    const unauthorized = planFollowup({ results: [result("network-observability", "active-directory")], alreadyRun: ["network-observability"], ctx: bobCtx, registry: serviceRegistry, entities: {}, budgetUsed: false, maxAgentsPerRequest: managerAgent.spec.execution.maxAgentsPerRequest });
    expect(unauthorized.rejections[0]?.reason).toBe("unauthorized");
    const invalid = planFollowup({ results: [result("active-directory", "openshift")], alreadyRun: ["active-directory"], ctx, registry: serviceRegistry, entities: {}, budgetUsed: false, maxAgentsPerRequest: managerAgent.spec.execution.maxAgentsPerRequest });
    expect(invalid.rejections[0]?.reason).toBe("not-allowed");
  });
});
