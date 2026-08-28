import { describe, expect, it } from "vitest";
import { loadAgentRegistry } from "@sre/config";
import type { SpecialistAgentConfig } from "@sre/agent-schema";
import { AuthorizationService, KeycloakWorkloadCredentialExchanger, audienceScopeFor, type RequestIdentity, type WorkloadIdentity } from "../src/index.ts";

/**
 * TDD §55 — the Agent → MCP → Tool authorization matrix, asserted explicitly.
 * These are the decisions a compromised Agent must not be able to talk its way
 * past, so each one is pinned rather than inferred from a happy-path test.
 */

const registry = loadAgentRegistry({ agentsDir: "agents", promptsDir: "prompts", approvedCatalogFile: "policies/approved-tools.yaml" });
const authorization = new AuthorizationService(registry);

const alice: RequestIdentity = { subject: "alice", groups: ["identity-platform"], roles: ["infra-read"], requestId: "req-1" };

function agent(name: string): SpecialistAgentConfig {
  const found = registry.getSpecialist(name);
  if (found === undefined) throw new Error(`missing agent ${name}`);
  return found;
}

function tool(serverId: string, toolName: string) {
  const approved = registry.catalog.tools.find((item) => item.serverId === serverId && item.toolName === toolName);
  if (approved === undefined) throw new Error(`missing approved tool ${serverId}/${toolName}`);
  return approved;
}

/** an approved tool entry for a server that this agent has no policy for */
function foreignTool(serverId: string) {
  const approved = registry.catalog.tools.find((item) => item.serverId === serverId);
  if (approved === undefined) throw new Error(`missing approved tool on ${serverId}`);
  return approved;
}

describe("Agent → MCP → Tool authorization", () => {
  it("ALLOWS the keycloak agent to call an allowed tool on its own MCP", () => {
    expect(authorization.preflightTool(alice, agent("keycloak"), tool("keycloak", "list_clients"), "prod").allowed).toBe(true);
  });

  it("DENIES the keycloak agent a tool that is not in its policy", () => {
    const blocked = registry.catalog.tools.find((item) => item.serverId === "keycloak" && !agent("keycloak").spec.access.some((entry) => entry.mcp === "keycloak" && entry.tools.includes(item.toolName)));
    // if every catalog tool on keycloak is granted, assert the negative directly
    if (blocked === undefined) {
      expect(agent("keycloak").spec.access.find((entry) => entry.mcp === "keycloak")?.tools).not.toContain("create_user");
      return;
    }
    expect(authorization.preflightTool(alice, agent("keycloak"), blocked, "prod").allowed).toBe(false);
  });

  it("DENIES the keycloak agent any tool on the Prometheus MCP", () => {
    expect(authorization.preflightTool(alice, agent("keycloak"), foreignTool("prometheus"), "prod").allowed).toBe(false);
  });

  it("DENIES a tool name granted on another MCP (no cross-MCP tool bleed)", () => {
    // observability may call `query` on prometheus; keycloak may not, even though
    // both agents can reach the wiki MCP and share tool-name space
    expect(authorization.preflightTool(alice, agent("observability"), tool("prometheus", "query"), "prod").allowed).toBe(true);
    expect(authorization.preflightTool(alice, agent("keycloak"), tool("prometheus", "query"), "prod").allowed).toBe(false);
  });

  it("DENIES every MCP when the agent is not active", () => {
    const disabled: SpecialistAgentConfig = { ...agent("keycloak"), spec: { ...agent("keycloak").spec, lifecycle: "disabled" } };
    expect(authorization.authorizeAgent(alice, disabled, "prod").allowed).toBe(false);
    expect(authorization.preflightTool(alice, disabled, tool("keycloak", "list_clients"), "prod").allowed).toBe(false);
    expect(authorization.preflightTool(alice, disabled, tool("wiki", "wiki_search"), "prod").allowed).toBe(false);
  });

  it("DENIES a user without the agent's required role", () => {
    const bob: RequestIdentity = { subject: "bob", groups: [], roles: ["network-read"], requestId: "req-2" };
    expect(authorization.preflightTool(bob, agent("keycloak"), tool("keycloak", "list_clients"), "prod").allowed).toBe(false);
  });

  it("DENIES a tool outside the request environment", () => {
    expect(authorization.preflightTool(alice, agent("keycloak"), tool("keycloak", "list_clients"), "nonexistent-env").allowed).toBe(false);
  });
});

describe("audience → resource binding", () => {
  it("ALLOWS the audience declared for that MCP", () => {
    expect(authorization.authorizeAudience(agent("keycloak"), "keycloak", "sre-toolhive:keycloak").allowed).toBe(true);
    expect(authorization.authorizeAudience(agent("keycloak"), "wiki", "sre-toolhive:wiki").allowed).toBe(true);
  });

  it("DENIES a keycloak-scoped credential presented to a different MCP", () => {
    expect(authorization.authorizeAudience(agent("keycloak"), "wiki", "sre-toolhive:keycloak").allowed).toBe(false);
  });

  it("DENIES an MCP that is not in the agent's policy at all", () => {
    expect(authorization.authorizeAudience(agent("keycloak"), "prometheus", "sre-toolhive:prometheus").allowed).toBe(false);
  });

  it("DENIES a catch-all audience", () => {
    expect(authorization.authorizeAudience(agent("keycloak"), "keycloak", "sre-toolhive:all").allowed).toBe(false);
    expect(authorization.authorizeAudience(agent("keycloak"), "keycloak", "aud=all-mcps").allowed).toBe(false);
  });
});

describe("workload token acquisition", () => {
  const workload: WorkloadIdentity = { clientId: "sre-agent-keycloak", provider: "keycloak", agentId: "keycloak" };

  function exchanger(responder: (body: URLSearchParams) => { status: number; json: unknown }): KeycloakWorkloadCredentialExchanger {
    return new KeycloakWorkloadCredentialExchanger({
      tokenEndpoint: "https://idp.test/token",
      clientId: "sre-agent-keycloak",
      clientSecret: () => "test-only-secret",
      issuer: "https://idp.test/realms/sre",
      fetchImplementation: (async (_url: string, init: RequestInit) => {
        const result = responder(new URLSearchParams(init.body as string));
        return new Response(JSON.stringify(result.json), { status: result.status, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    });
  }

  it("requests exactly one MCP audience scope per call", async () => {
    const scopes: string[] = [];
    const client = exchanger((body) => {
      scopes.push(body.get("scope") ?? "");
      return { status: 200, json: { access_token: "a".repeat(32), expires_in: 60 } };
    });
    await client.exchange(workload, alice, "sre-toolhive:keycloak", Date.now() + 30_000);
    await client.exchange(workload, alice, "sre-toolhive:wiki", Date.now() + 30_000);
    expect(scopes).toEqual(["sre-toolhive-keycloak", "sre-toolhive-wiki"]);
    expect(scopes.every((scope) => !scope.includes(" "))).toBe(true);
  });

  it("binds the credential to the agent's own workload identity", async () => {
    const client = exchanger(() => ({ status: 200, json: { access_token: "a".repeat(32), expires_in: 60 } }));
    const credential = await client.exchange(workload, alice, "sre-toolhive:keycloak", Date.now() + 30_000);
    expect(credential).toMatchObject({ workloadClientId: "sre-agent-keycloak", audience: "sre-toolhive:keycloak" });
  });

  it("refuses to present another agent's workload identity", async () => {
    const client = exchanger(() => ({ status: 200, json: { access_token: "a".repeat(32), expires_in: 60 } }));
    const impersonated: WorkloadIdentity = { clientId: "sre-agent-observability", provider: "keycloak", agentId: "observability" };
    await expect(client.exchange(impersonated, alice, "sre-toolhive:prometheus", Date.now() + 30_000)).rejects.toMatchObject({ code: "TOOL_DENIED" });
  });

  it("fails closed when the IdP rejects the workload", async () => {
    const client = exchanger(() => ({ status: 401, json: { error: "invalid_client" } }));
    await expect(client.exchange(workload, alice, "sre-toolhive:keycloak", Date.now() + 30_000)).rejects.toMatchObject({ code: "TOOL_DENIED" });
  });

  it("caches per audience without leaking one audience's token to another", async () => {
    let calls = 0;
    const client = exchanger(() => {
      calls += 1;
      return { status: 200, json: { access_token: `token-${calls}`.padEnd(32, "x"), expires_in: 60 } };
    });
    const first = await client.exchange(workload, alice, "sre-toolhive:keycloak", Date.now() + 30_000);
    const second = await client.exchange(workload, alice, "sre-toolhive:keycloak", Date.now() + 30_000);
    const other = await client.exchange(workload, alice, "sre-toolhive:wiki", Date.now() + 30_000);
    expect(calls).toBe(2);
    expect(second.token).toBe(first.token);
    expect(other.token).not.toBe(first.token);
  });

  it("derives the scope name from the audience", () => {
    expect(audienceScopeFor("sre-toolhive:prometheus")).toBe("sre-toolhive-prometheus");
  });
});
