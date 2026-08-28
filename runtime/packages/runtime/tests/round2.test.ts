import { AuthorizationService } from "@sre/auth";
import { loadAgentRegistry } from "@sre/config";
import { domainHandoffSchema, type SpecialistResult } from "@sre/evidence";
import { MockModelClient, type ChatRequest, type ChatResponse, type ModelClient } from "@sre/llm";
import { MockToolHiveClient } from "@sre/mcp";
import { describe, expect, it } from "vitest";
import { buildDomainHandoff, executeRequest, planRound2, runSpecialist, type ExecutionContext } from "../src/index.ts";
import { distributedRuntime, managerAgent, serviceRegistry } from "./distributed-fixture.ts";

const registry = loadAgentRegistry({ agentsDir: "agents", promptsDir: "prompts", approvedCatalogFile: "policies/approved-tools.yaml" });
const identity = { subject: "alice", groups: [], roles: ["infra-read", "network-read"], requestId: "req-r2" };
const ctx: ExecutionContext = { request: { question: "AD replication has a network dependency", identity }, identity, environment: "prod", intent: "diagnostic", requestId: identity.requestId, deadline: Date.now() + 5000 };
const authorization = new AuthorizationService(registry);
const result = (agentId: string, needsDomain: string, secret = "hidden transcript"): SpecialistResult => ({ agentId, status: "complete", summary: secret, needsDomain: [needsDomain], evidence: [{ id: `${agentId}-e`, kind: "telemetry", source: agentId, system: agentId, environment: "prod", rawExcerpt: secret, payload: { secret }, citation: `mcp://${agentId}`, status: "ok", requestId: identity.requestId, agentId }] });

describe("T5 bounded Round 2", () => {
  it("executes one authorized discovered domain and never recurses", async () => {
    const model = new MockModelClient();
    const runtime = distributedRuntime(model);
    const response = await executeRequest({ question: "AD replication has a network dependency", identity }, runtime);
    expect(response.metadata.routedAgents).toEqual(["active-directory", "network-observability"]);
    expect(runtime.agentClient.mode).toBe("mock");
    expect(response.metadata.tierLUsed).toBe(true);
  });

  it("rejects a second discovered request after the single budget is allocated", () => {
    const plan = planRound2({ results: [result("active-directory", "network-observability"), result("openshift", "network-observability")], alreadyRun: ["active-directory", "openshift"], ctx, registry: serviceRegistry, entities: {}, budgetUsed: false, maxAgentsPerRequest: managerAgent.spec.execution.maxAgentsPerRequest, allowedManagerAgents: managerAgent.spec.agents.allowed });
    expect(plan.request?.agentId).toBe("network-observability");
    expect(plan.rejections).toEqual([expect.objectContaining({ reason: "budget-exhausted" })]);
    const exhausted = planRound2({ results: [result("active-directory", "network-observability")], alreadyRun: ["active-directory"], ctx, registry: serviceRegistry, entities: {}, budgetUsed: true, maxAgentsPerRequest: managerAgent.spec.execution.maxAgentsPerRequest, allowedManagerAgents: managerAgent.spec.agents.allowed });
    expect(exhausted.request).toBeUndefined();
    expect(exhausted.rejections[0]?.reason).toBe("budget-exhausted");
    const totalAgentBudget = planRound2({ results: [result("active-directory", "network-observability")], alreadyRun: ["active-directory", "openshift", "another-agent"], ctx, registry: serviceRegistry, entities: {}, budgetUsed: false, maxAgentsPerRequest: managerAgent.spec.execution.maxAgentsPerRequest, allowedManagerAgents: managerAgent.spec.agents.allowed });
    expect(totalAgentBudget.rejections[0]?.reason).toBe("budget-exhausted");
  });

  it("rejects unauthorized and non-allowlisted domains", () => {
    const bob = { subject: "bob", groups: [], roles: ["network-read"], requestId: "req-bob" };
    const bobCtx = { ...ctx, identity: bob, request: { question: ctx.request.question, identity: bob }, requestId: bob.requestId };
    const unauthorized = planRound2({ results: [result("network-observability", "active-directory")], alreadyRun: ["network-observability"], ctx: bobCtx, registry: serviceRegistry, entities: {}, budgetUsed: false, maxAgentsPerRequest: managerAgent.spec.execution.maxAgentsPerRequest, allowedManagerAgents: managerAgent.spec.agents.allowed });
    expect(unauthorized.rejections[0]?.reason).toBe("unauthorized");
    const invalid = planRound2({ results: [result("active-directory", "openshift")], alreadyRun: ["active-directory"], ctx, registry: serviceRegistry, entities: {}, budgetUsed: false, maxAgentsPerRequest: managerAgent.spec.execution.maxAgentsPerRequest, allowedManagerAgents: managerAgent.spec.agents.allowed });
    expect(invalid.rejections[0]?.reason).toBe("not-allowed");
  });

  it("builds a scalar-only handoff without summaries, payloads, excerpts, or transcripts", async () => {
    const source = result("active-directory", "network-observability", "TOP_SECRET_TRANSCRIPT");
    const handoff = buildDomainHandoff(ctx.request.question, source, { hostname: "DC-TLV-01" });
    const serialized = JSON.stringify(handoff);
    expect(serialized).not.toContain("TOP_SECRET_TRANSCRIPT");
    expect(serialized).not.toMatch(/summary|payload|rawExcerpt/iu);
    expect(() => domainHandoffSchema.parse({ ...handoff, sanitizedFacts: [{ key: "bad", value: { nested: true } }] })).toThrow();

    class InspectingModel implements ModelClient {
      readonly mode = "mock" as const;
      requests: ChatRequest[] = [];
      async chat(request: ChatRequest): Promise<ChatResponse> { this.requests.push(request); return request.guidedJsonSchema ? { content: JSON.stringify({ summary: "Checked." }), usage: { promptTokens: 1, completionTokens: 1 } } : { usage: { promptTokens: 1, completionTokens: 1 } }; }
    }
    const model = new InspectingModel();
    await runSpecialist("network-observability", ctx, { registry, authorization, model, toolhive: new MockToolHiveClient() }, handoff);
    expect(JSON.stringify(model.requests)).not.toContain("TOP_SECRET_TRANSCRIPT");
  });
});
