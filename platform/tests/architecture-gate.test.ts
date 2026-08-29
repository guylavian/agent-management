import { describe, expect, it } from "vitest";
import { CONFIG_PATHS, loadAgentRegistry } from "@sre/config";
import { invokeVisibleTool, visibleTools } from "@sre/agent-engine/testing";
import { MockToolHiveClient, toAgentDefinition, toToolPolicy } from "@sre/runtime-host";
import { AuthorizationService, MockOidcClient } from "@sre/auth";

const registry = loadAgentRegistry(CONFIG_PATHS);
const policy = toToolPolicy(registry.catalog);
const definition = (agentId: string) => toAgentDefinition(registry.getSpecialist(agentId)!);

describe("T1 architecture gate", () => {
  it("AG-01 preserves distinct effective human identities in gateway audit", async () => {
    const oidc = new MockOidcClient({ issuer: "https://mock-idp.sre.local", audience: "sre-assistant" });
    const alice = await oidc.verify(await oidc.issueTestToken("alice"), "req-alice");
    const bob = await oidc.verify(await oidc.issueTestToken("bob"), "req-bob");
    const gateway = new MockToolHiveClient();
    await invokeVisibleTool(definition("active-directory"), policy, gateway, { serverId: "active-directory", toolName: "get_dc_health", arguments: { dc: "DC1" }, environment: "prod", requestId: alice.requestId, principal: alice, timeoutMs: 100 });
    await invokeVisibleTool(definition("network-observability"), policy, gateway, { serverId: "network", toolName: "get_path_health", arguments: { target: "api" }, environment: "prod", requestId: bob.requestId, principal: bob, timeoutMs: 100 });
    expect(gateway.audit.map((event) => [event.requestId, event.subject])).toEqual([["req-alice", "alice"], ["req-bob", "bob"]]);
  });

  it("AG-02 denies an unauthorized tool before any backend call", async () => {
    const oidc = new MockOidcClient({ issuer: "https://mock-idp.sre.local", audience: "sre-assistant" });
    const bob = await oidc.verify(await oidc.issueTestToken("bob"), "req-denied");
    const gateway = new MockToolHiveClient();
    await expect(invokeVisibleTool(definition("active-directory"), policy, gateway, { serverId: "active-directory", toolName: "get_dc_health", arguments: { dc: "DC1" }, environment: "prod", requestId: bob.requestId, principal: bob, timeoutMs: 100 })).rejects.toMatchObject({ code: "TOOL_DENIED" });
    expect(gateway.backendCalls).toHaveLength(0);
    expect(await visibleTools(definition("active-directory"), policy, gateway, bob, "prod")).toEqual([]);
  });

  it("AG-03 exposes no mutating capability", () => {
    expect(registry.catalog.tools.every((tool) => tool.readOnlyVerified)).toBe(true);
    expect(registry.catalog.tools.some((tool) => /^(create|update|delete|patch|restart|write|set)_/u.test(tool.toolName))).toBe(false);
  });

  it("does not let routing widen agent authorization", async () => {
    const oidc = new MockOidcClient({ issuer: "https://mock-idp.sre.local", audience: "sre-assistant" });
    const bob = await oidc.verify(await oidc.issueTestToken("bob"), "req-route");
    const authz = new AuthorizationService(registry);
    expect(authz.filterAuthorizedAgents(bob, ["active-directory", "openshift", "network-observability"], "prod")).toEqual(["network-observability"]);
  });
});
