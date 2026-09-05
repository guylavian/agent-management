import { describe, expect, it } from "vitest";
import { CONFIG_PATHS, loadAgentRegistry } from "@sre/config";
import type { SpecialistAgentConfig } from "@sre/agent-schema";
import {
  audienceScopeName,
  desiredClientFor,
  desiredClientsFor,
  reconcileAll,
  reconcileClient,
  toolRoleName,
  type ActualClient,
  type DesiredAudienceScope,
  type DesiredClient,
  type KeycloakAdmin,
} from "../src/index.ts";

/** In-memory realm. It enforces the same shape the real Admin API does; nothing is loosened to make tests pass. */
class InMemoryKeycloak implements KeycloakAdmin {
  readonly clients = new Map<string, ActualClient>();
  readonly roles = new Map<string, Set<string>>();
  readonly optionalScopes = new Map<string, Set<string>>();
  readonly scopes = new Map<string, DesiredAudienceScope>();
  writes = 0;
  #nextId = 1;

  async getClient(clientId: string): Promise<ActualClient | undefined> {
    return [...this.clients.values()].find((client) => client.clientId === clientId);
  }
  async createClient(desired: DesiredClient): Promise<string> {
    this.writes += 1;
    const id = `uuid-${this.#nextId++}`;
    this.clients.set(id, { id, clientId: desired.clientId, enabled: desired.enabled, serviceAccountsEnabled: true, standardFlowEnabled: false, publicClient: false, attributes: { ...desired.attributes } });
    this.roles.set(id, new Set());
    this.optionalScopes.set(id, new Set());
    return id;
  }
  async updateClient(id: string, desired: DesiredClient): Promise<void> {
    this.writes += 1;
    const existing = this.clients.get(id);
    if (existing === undefined) throw new Error("no such client");
    this.clients.set(id, { ...existing, enabled: desired.enabled, serviceAccountsEnabled: true, standardFlowEnabled: false, publicClient: false, attributes: { ...desired.attributes } });
  }
  async setClientEnabled(id: string, enabled: boolean): Promise<void> {
    this.writes += 1;
    const existing = this.clients.get(id);
    if (existing !== undefined) this.clients.set(id, { ...existing, enabled });
  }
  async listClientRoles(id: string): Promise<string[]> {
    return [...(this.roles.get(id) ?? [])];
  }
  async createClientRole(id: string, name: string): Promise<void> {
    this.writes += 1;
    this.roles.get(id)?.add(name);
  }
  async removeClientRole(id: string, name: string): Promise<void> {
    this.writes += 1;
    this.roles.get(id)?.delete(name);
  }
  async ensureAudienceScope(scope: DesiredAudienceScope): Promise<void> {
    if (!this.scopes.has(scope.name)) {
      this.writes += 1;
      this.scopes.set(scope.name, scope);
    }
  }
  async listOptionalClientScopes(id: string): Promise<string[]> {
    return [...(this.optionalScopes.get(id) ?? [])];
  }
  async addOptionalClientScope(id: string, scopeName: string): Promise<void> {
    this.writes += 1;
    if (!this.scopes.has(scopeName)) throw new Error(`client scope ${scopeName} does not exist`);
    this.optionalScopes.get(id)?.add(scopeName);
  }
  async removeOptionalClientScope(id: string, scopeName: string): Promise<void> {
    this.writes += 1;
    this.optionalScopes.get(id)?.delete(scopeName);
  }
}

function specialists(): SpecialistAgentConfig[] {
  return loadAgentRegistry(CONFIG_PATHS).listSpecialists();
}

function keycloakAgent(): SpecialistAgentConfig {
  const agent = specialists().find((item) => item.name === "keycloak");
  if (agent === undefined) throw new Error("keycloak agent missing");
  return agent;
}

describe("desired Keycloak state", () => {
  it("derives one dedicated workload client per agent", () => {
    const agents = specialists();
    const clients = desiredClientsFor(agents);
    // derived from the agents handed in: a literal list here fails whenever an
    // Agent is added, which is a routine config change and not a regression
    expect(clients.map((client) => client.clientId).sort())
      .toEqual(agents.map((agent) => `sre-agent-${agent.name}`).sort());
    // no shared credential: every agent has its own client
    expect(new Set(clients.map((client) => client.clientId)).size).toBe(clients.length);
  });

  it("models each MCP audience as a separate optional scope so no token carries every audience", () => {
    const client = desiredClientFor(keycloakAgent());
    expect(client.optionalClientScopes.map((scope) => scope.audience).sort()).toEqual(["sre-toolhive:keycloak", "sre-toolhive:wiki"]);
    expect(client.optionalClientScopes.map((scope) => scope.name)).toContain(audienceScopeName("keycloak"));
    // prometheus is not in this agent's policy, so no scope can mint that audience
    expect(client.optionalClientScopes.some((scope) => scope.mcp === "prometheus")).toBe(false);
  });

  it("expresses Agent → MCP → Tool grants as per-MCP client roles", () => {
    const client = desiredClientFor(keycloakAgent());
    expect(client.roles.map((role) => role.name)).toContain(toolRoleName("keycloak", "list_clients"));
    expect(client.roles.map((role) => role.name)).toContain(toolRoleName("wiki", "wiki_search"));
    expect(client.roles.map((role) => role.name)).not.toContain(toolRoleName("keycloak", "create_user"));
    expect(client.roles.map((role) => role.name)).not.toContain(toolRoleName("prometheus", "query"));
  });

  it("is a confidential service-account client with short-lived tokens and no interactive flow", () => {
    const client = desiredClientFor(keycloakAgent());
    expect(client).toMatchObject({ publicClient: false, serviceAccountsEnabled: true, standardFlowEnabled: false, directAccessGrantsEnabled: false });
    expect(client.attributes["access.token.lifespan"]).toBe("60");
  });

  it("enables RFC 8693 token exchange on the client", () => {
    const client = desiredClientFor(keycloakAgent());
    expect(client.attributes["standard.token.exchange.enabled"]).toBe("true");
  });

  it("never carries secret material", () => {
    expect(JSON.stringify(desiredClientFor(keycloakAgent()))).not.toMatch(/secret|password|private[_-]?key/iu);
  });
});

describe("reconciliation", () => {
  it("creates the client, its audience scopes and its tool grants", async () => {
    const admin = new InMemoryKeycloak();
    const result = await reconcileClient(admin, desiredClientFor(keycloakAgent()));
    expect(result.action).toBe("created");
    const created = await admin.getClient("sre-agent-keycloak");
    expect(created?.enabled).toBe(true);
    expect(await admin.listOptionalClientScopes(created!.id)).toEqual(expect.arrayContaining(["sre-toolhive-keycloak", "sre-toolhive-wiki"]));
    expect(await admin.listClientRoles(created!.id)).toContain("keycloak:list_clients");
  });

  it("is idempotent — a second run writes nothing", async () => {
    const admin = new InMemoryKeycloak();
    const desired = desiredClientFor(keycloakAgent());
    await reconcileClient(admin, desired);
    const writesAfterCreate = admin.writes;
    const second = await reconcileClient(admin, desired);
    expect(second.action).toBe("unchanged");
    expect(second.changes).toEqual([]);
    expect(admin.writes).toBe(writesAfterCreate);
  });

  it("revokes a tool grant that was removed from the canonical policy", async () => {
    const admin = new InMemoryKeycloak();
    const desired = desiredClientFor(keycloakAgent());
    await reconcileClient(admin, desired);
    const narrowed: DesiredClient = { ...desired, roles: desired.roles.filter((role) => role.name !== "keycloak:list_clients") };
    const result = await reconcileClient(admin, narrowed);
    expect(result.changes).toContain("revoke keycloak:list_clients");
    const client = await admin.getClient("sre-agent-keycloak");
    expect(await admin.listClientRoles(client!.id)).not.toContain("keycloak:list_clients");
  });

  it("detaches an audience scope that is no longer in policy", async () => {
    const admin = new InMemoryKeycloak();
    const desired = desiredClientFor(keycloakAgent());
    await reconcileClient(admin, desired);
    const narrowed: DesiredClient = { ...desired, optionalClientScopes: desired.optionalClientScopes.filter((scope) => scope.mcp !== "wiki") };
    const result = await reconcileClient(admin, narrowed);
    expect(result.changes).toContain("detach optional scope sre-toolhive-wiki");
    const client = await admin.getClient("sre-agent-keycloak");
    expect(await admin.listOptionalClientScopes(client!.id)).not.toContain("sre-toolhive-wiki");
  });

  it("disables the workload client when the agent is not active, and never deletes it", async () => {
    const admin = new InMemoryKeycloak();
    const desired = desiredClientFor(keycloakAgent());
    await reconcileClient(admin, desired);
    const result = await reconcileClient(admin, { ...desired, enabled: false, attributes: { ...desired.attributes, "sre.agent.lifecycle": "disabled" } });
    expect(result.action).toBe("disabled");
    const client = await admin.getClient("sre-agent-keycloak");
    expect(client).toBeDefined();
    expect(client?.enabled).toBe(false);
  });

  it("re-confidentialises a client that drifted to a public interactive client", async () => {
    const admin = new InMemoryKeycloak();
    const desired = desiredClientFor(keycloakAgent());
    await reconcileClient(admin, desired);
    const client = await admin.getClient("sre-agent-keycloak");
    admin.clients.set(client!.id, { ...client!, publicClient: true, standardFlowEnabled: true, serviceAccountsEnabled: false });
    const result = await reconcileClient(admin, desired);
    expect(result.changes).toEqual(expect.arrayContaining(["enable service account", "disable standard flow", "make client confidential"]));
    expect((await admin.getClient("sre-agent-keycloak"))?.publicClient).toBe(false);
  });

  it("adds token exchange attribute to an existing client that lacks it", async () => {
    const admin = new InMemoryKeycloak();
    const desired = desiredClientFor(keycloakAgent());
    // Create a client without the token exchange attribute (simulating an old client)
    const oldDesired = { ...desired, attributes: { ...desired.attributes } };
    delete oldDesired.attributes["standard.token.exchange.enabled"];
    await reconcileClient(admin, oldDesired);
    const client = await admin.getClient("sre-agent-keycloak");
    expect(client?.attributes["standard.token.exchange.enabled"]).toBeUndefined();
    // Now reconcile with the desired state that includes the attribute
    const result = await reconcileClient(admin, desired);
    expect(result.changes).toContain("set attribute standard.token.exchange.enabled=true");
    expect((await admin.getClient("sre-agent-keycloak"))?.attributes["standard.token.exchange.enabled"]).toBe("true");
  });

  it("dry run reports the plan without writing", async () => {
    const admin = new InMemoryKeycloak();
    const result = await reconcileClient(admin, desiredClientFor(keycloakAgent()), { dryRun: true });
    expect(result.action).toBe("created");
    expect(result.changes.length).toBeGreaterThan(0);
    expect(admin.writes).toBe(0);
    expect(await admin.getClient("sre-agent-keycloak")).toBeUndefined();
  });

  it("reconciles every agent and isolates a single failure", async () => {
    const admin = new InMemoryKeycloak();
    const desired = desiredClientsFor(specialists());
    // one client cannot be created; the others must still be reconciled
    const failing = desired[0]!.clientId;
    const originalCreate = admin.createClient.bind(admin);
    admin.createClient = async (client) => {
      if (client.clientId === failing) throw new Error("keycloak unavailable");
      return originalCreate(client);
    };
    const results = await reconcileAll(admin, desired);
    // one result per desired client, derived rather than counted
    expect(results).toHaveLength(desired.length);
    expect(results.filter((result) => "error" in result)).toHaveLength(1);
    // every client except the one that failed — isolation, not a fixed count
    expect(admin.clients.size).toBe(desired.length - 1);
  });
});
