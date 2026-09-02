import { MockModelClient } from "@sre/llm";
import { StaticAgentCatalog, type AgentCatalogEntry } from "@sre/config";
import { describe, expect, it } from "vitest";
import { executeRequest, MockSpecialistTransport, planFollowup, type ExecutionContext } from "../src/index.ts";
import { distributedRuntime, serviceRegistry } from "./distributed-fixture.ts";

const identity = { subject: "alice", groups: [], roles: ["infra-read", "network-read"], requestId: "req-derived" };

/**
 * ROUTING IS DERIVED, AND IT IS THE ONLY GATE.
 *
 * There used to be a hand-written `manager.spec.agents.allowed` list in front
 * of the effective catalog. Onboarding an Agent therefore took two merged pull
 * requests, and the second one had no failure mode: the Agent existed, Argo
 * synced it, the pod was ready, and the Manager was simply never offered it.
 *
 * These tests pin the replacement in both directions. An Agent this environment
 * does not enable is never routed — in Round 1 or Round 2 — and one it does
 * enable is routable with no other file being touched.
 */
function catalogWith(overrides: Record<string, Partial<AgentCatalogEntry>>): StaticAgentCatalog {
  const entries = serviceRegistry.listEnabled().map((entry) => ({ ...entry, ...overrides[entry.agentId] }));
  return new StaticAgentCatalog(entries);
}

describe("the effective catalog is the routing table", () => {
  it("never routes to a specialist this environment has disabled", async () => {
    const client = new MockSpecialistTransport();
    // openshift exists and is registered; the deployment overlay turns it off
    const deps = { ...distributedRuntime(new MockModelClient(), client), registry: catalogWith({ openshift: { enabled: false } }) };
    const response = await executeRequest({ question: "OpenShift pod CrashLoopBackOff in namespace payments", identity }, deps);
    expect(response.metadata.routedAgents).not.toContain("openshift");
    expect(client.calls.some((call) => call.agentId === "openshift")).toBe(false);
  });

  it("routes to it again once it is re-enabled, with no other file changing", async () => {
    const client = new MockSpecialistTransport();
    const deps = { ...distributedRuntime(new MockModelClient(), client), registry: catalogWith({}) };
    const response = await executeRequest({ question: "OpenShift pod CrashLoopBackOff in namespace payments", identity }, deps);
    // the ONLY difference from the case above is the overlay's `enabled` flag
    expect(response.metadata.routedAgents).toContain("openshift");
  });

  it("rejects a Round-2 discovered domain that this environment does not enable", () => {
    const ctx: ExecutionContext = { request: { question: "AD replication has a network dependency", identity }, identity, environment: "prod", intent: "diagnostic", requestId: identity.requestId, deadline: Date.now() + 5000 };
    const plan = planFollowup({
      results: [{ agentId: "active-directory", status: "complete", needsHandoff: ["network-observability"], evidence: [{ id: "e", kind: "telemetry", source: "ad", system: "ad", environment: "prod", citation: "tool://ad", status: "ok", requestId: identity.requestId, agentId: "active-directory" }] }],
      alreadyRun: ["active-directory"],
      ctx,
      registry: catalogWith({ "network-observability": { enabled: false } }),
      entities: {},
      budgetUsed: false,
      maxAgentsPerRequest: 3,
    });
    expect(plan.request).toBeUndefined();
    // "not enabled here" is its own reason: conflating it with an authorization
    // denial would send an operator to Keycloak to fix a deployment overlay
    expect(plan.rejections).toEqual([expect.objectContaining({ domain: "network-observability", reason: "not-enabled" })]);
  });

  it("separates 'this environment disabled it' from 'its pod is not answering'", () => {
    // an availability-gated catalog reports enabled-but-unreachable; sending an
    // operator to edit a deployment overlay to fix a crash-looping pod is the
    // class of misdiagnosis this whole view exists to end
    const ctx: ExecutionContext = { request: { question: "AD replication has a network dependency", identity }, identity, environment: "prod", intent: "diagnostic", requestId: identity.requestId, deadline: Date.now() + 5000 };
    const desired = catalogWith({});
    const unavailable: typeof desired = {
      resolve: (id: string) => desired.resolve(id),
      listEnabled: (env?: string) => desired.listEnabled(env).filter(entry => entry.agentId !== "network-observability"),
      filterAuthorized: (ids: string[], roles: string[], env: string) => desired.filterAuthorized(ids, roles, env).filter(id => id !== "network-observability"),
      mayRequestDomain: (from: string, to: string) => desired.mayRequestDomain(from, to),
    } as never;
    const plan = planFollowup({
      results: [{ agentId: "active-directory", status: "complete", needsHandoff: ["network-observability"], evidence: [{ id: "e", kind: "telemetry", source: "ad", system: "ad", environment: "prod", citation: "tool://ad", status: "ok", requestId: identity.requestId, agentId: "active-directory" }] }],
      alreadyRun: ["active-directory"],
      ctx,
      registry: unavailable,
      entities: {},
      budgetUsed: false,
      maxAgentsPerRequest: 3,
    });
    expect(plan.rejections).toEqual([expect.objectContaining({ domain: "network-observability", reason: "not-available" })]);
  });

  it("takes the follow-up when the same domain IS enabled", () => {
    const ctx: ExecutionContext = { request: { question: "AD replication has a network dependency", identity }, identity, environment: "prod", intent: "diagnostic", requestId: identity.requestId, deadline: Date.now() + 5000 };
    const plan = planFollowup({
      results: [{ agentId: "active-directory", status: "complete", needsHandoff: ["network-observability"], evidence: [{ id: "e", kind: "telemetry", source: "ad", system: "ad", environment: "prod", citation: "tool://ad", status: "ok", requestId: identity.requestId, agentId: "active-directory" }] }],
      alreadyRun: ["active-directory"],
      ctx,
      registry: catalogWith({}),
      entities: {},
      budgetUsed: false,
      maxAgentsPerRequest: 3,
    });
    expect(plan.request?.agentId).toBe("network-observability");
  });
});
