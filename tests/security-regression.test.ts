import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from "vitest";
import { AuthorizationService, MockToolCredentialAuthority, type RequestIdentity, type WorkloadIdentity } from "@sre/auth";
import { CONFIG_PATHS, loadAgentRegistry, loadAppConfig, ConfigValidationError, isToolAllowed } from "@sre/config";
import { MockToolHiveClient, invokeVisibleToolForSpecialist, toolHiveAudience } from "@sre/agent-engine";
import { buildDependencies, createApp, type ManagerDependencies } from "@sre/runtime-host";

/**
 * TDD §57 — security regressions. Each of these is an invariant that a future
 * refactor could plausibly break quietly, so it is asserted rather than assumed.
 */

const registry = loadAgentRegistry(CONFIG_PATHS);
const authorization = new AuthorizationService(registry);
const alice: RequestIdentity = { subject: "alice", groups: ["identity-platform"], roles: ["infra-read"], requestId: "req-sec-1" };
const keycloakAgent = registry.getSpecialist("keycloak")!;
const keycloakWorkload: WorkloadIdentity = { clientId: "sre-agent-keycloak", provider: "keycloak", agentId: "keycloak" };

function authority() {
  return new MockToolCredentialAuthority({ issuer: "https://mock-toolhive-sts.sre.local", secret: "security-regression-shared-secret-32b" });
}

describe("an agent cannot reach outside its policy", () => {
  it("cannot call an MCP that is not in its access policy", async () => {
    const auth = authority();
    const credential = await auth.exchange(keycloakWorkload, alice, toolHiveAudience("prometheus"), Date.now() + 20_000);
    await expect(
      invokeVisibleToolForSpecialist(registry.catalog, authorization, new MockToolHiveClient(auth), keycloakAgent, {
        serverId: "prometheus",
        toolName: "query",
        arguments: {},
        environment: "prod",
        requestId: alice.requestId,
        identity: alice,
        credential,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: "TOOL_DENIED" });
  });

  it("cannot call a tool that is not in its policy on an MCP it does reach", () => {
    expect(isToolAllowed(keycloakAgent.spec, "keycloak", "create_user")).toBe(false);
    expect(isToolAllowed(keycloakAgent.spec, "keycloak", "delete_user")).toBe(false);
  });

  it("cannot present a credential minted for another MCP", async () => {
    const auth = authority();
    const wrongAudience = await auth.exchange(keycloakWorkload, alice, toolHiveAudience("prometheus"), Date.now() + 20_000);
    await expect(
      invokeVisibleToolForSpecialist(registry.catalog, authorization, new MockToolHiveClient(auth), keycloakAgent, {
        serverId: "keycloak",
        toolName: "list_clients",
        arguments: {},
        environment: "prod",
        requestId: alice.requestId,
        identity: alice,
        credential: wrongAudience,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: "TOOL_DENIED" });
  });

  it("is denied entirely once its lifecycle is not active", async () => {
    const disabled = { ...keycloakAgent, spec: { ...keycloakAgent.spec, lifecycle: "disabled" as const } };
    const auth = authority();
    const credential = await auth.exchange(keycloakWorkload, alice, toolHiveAudience("keycloak"), Date.now() + 20_000);
    await expect(
      invokeVisibleToolForSpecialist(registry.catalog, authorization, new MockToolHiveClient(auth), disabled, {
        serverId: "keycloak",
        toolName: "list_clients",
        arguments: {},
        environment: "prod",
        requestId: alice.requestId,
        identity: alice,
        credential,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: "TOOL_DENIED" });
  });
});

describe("ToolHive remains mandatory", () => {
  it("refuses a tool call with no verified credential", async () => {
    const gateway = new MockToolHiveClient(authority());
    await expect(
      gateway.invoke({ serverId: "keycloak", toolName: "list_clients", arguments: {}, environment: "prod", requestId: "r", identity: alice, timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "TOOL_DENIED" });
  });

  it("forbids the direct (ToolHive-bypassing) client outside local development", () => {
    expect(() => loadAppConfig({ SRE_ENV: "real-poc", SRE_CLIENT_TOOLHIVE: "direct" })).toThrow(ConfigValidationError);
    expect(() => loadAppConfig({ SRE_ENV: "production", SRE_CLIENT_TOOLHIVE: "direct" })).toThrow(ConfigValidationError);
  });

  it("forbids every mock dependency in production and real-poc", () => {
    expect(() => loadAppConfig({ SRE_ENV: "production" })).toThrow(/mock in production/u);
    expect(() => loadAppConfig({ SRE_ENV: "real-poc" })).toThrow(/mock in real-poc/u);
  });
});

describe("secrets never reach Git", () => {
  it("no agent YAML contains credential material", () => {
    for (const file of readdirSync("config/agents").filter(name => name.endsWith(".yaml"))) {
      const contents = readFileSync(`config/agents/${file}`, "utf8");
      expect(contents, file).not.toMatch(/client[_-]?secret|password|private[_-]?key|api[_-]?key|bearer /iu);
    }
  });

  it("config load rejects an agent document carrying a secret-like key", async () => {
    const { agentDocumentSchema, assertNoSecretMaterial } = await import("@sre/agent-schema");
    const doc = agentDocumentSchema.parse({
      ...JSON.parse(JSON.stringify({
        apiVersion: "sre.ai/v1alpha1",
        kind: "Agent",
        metadata: { name: "temp", owner: "team" },
        spec: {
          type: "specialist",
          model: { tier: "small", profile: "tool-caller" },
          prompt: { systemFile: "config/prompts/keycloak.md" },
          identity: { provider: "keycloak", clientId: "sre-agent-temp" },
          environments: ["prod"],
          access: [{ mcp: "wiki", tools: ["wiki_search"] }],
          execution: { maxToolCalls: 6, maxModelTurns: 6, timeoutMs: 120000, maxEvidenceBytes: 262144, maxContextTokens: 12000, maxEvidenceItems: 32, maxRawExcerptBytes: 8192 },
          authorization: { requiredRoles: ["infra-read"] },
        },
      })),
    });
    expect(() => assertNoSecretMaterial({ ...doc.spec, clientSecret: "hunter2" })).toThrow(/secret-like key/u);
  });

  it("every agent uses its own workload identity, never a shared one", () => {
    const clientIds = registry.listSpecialists().map(agent => agent.spec.identity.clientId);
    expect(new Set(clientIds).size).toBe(clientIds.length);
    expect(clientIds.every(id => id.startsWith("sre-agent-"))).toBe(true);
  });

  it("no agent declares a catch-all audience", () => {
    for (const agent of registry.listSpecialists()) {
      for (const entry of agent.spec.access) {
        expect(entry.audience).toBe(`sre-toolhive:${entry.mcp}`);
        expect(entry.audience).not.toMatch(/all|\*/u);
      }
    }
  });
});

describe("the portal cannot bypass the runtime", () => {
  it("the management API exposes no mutation of running policy", async () => {
    const deps = buildDependencies({ SRE_ENV: "local", AGENT_CONFIG: "config/agents/manager.yaml", SRE_CLIENT_AGENT: "mock" }) as ManagerDependencies;
    const app = createApp(deps);
    const token = (((await app.inject({ method: "POST", url: "/dev/token/alice" })).json()) as { token: string }).token;
    const headers = { authorization: `Bearer ${token}` };
    // the only writable endpoints propose a change; nothing edits the live registry
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({ method, url: "/management/agents/keycloak", headers });
      expect(response.statusCode).toBe(404);
    }
    const before = deps.managementRegistry?.getSpecialist("keycloak")?.spec.access.length;
    await app.inject({ method: "POST", url: "/management/agents/preview", headers: { ...headers, "content-type": "application/json" }, payload: JSON.stringify({ name: "keycloak", owner: "x", modelTier: "small", modelProfile: "tool-caller", requiredRoles: ["infra-read"], access: [{ mcp: "wiki", tools: ["wiki_search"] }] }) });
    expect(deps.managementRegistry?.getSpecialist("keycloak")?.spec.access.length).toBe(before);
  });

  it("does not serve MCP or ToolHive endpoints that a browser could call", async () => {
    const deps = buildDependencies({ SRE_ENV: "local", AGENT_CONFIG: "config/agents/manager.yaml", SRE_CLIENT_AGENT: "mock" }) as ManagerDependencies;
    const app = createApp(deps);
    // never reachable: either unauthenticated (401) or absent (404), never served
    for (const url of ["/mcp/keycloak", "/toolhive/keycloak", "/management/mcp/keycloak/call"]) {
      expect([401, 404]).toContain((await app.inject({ method: "POST", url })).statusCode);
    }
  });
});

/**
 * A model profile that cannot be resolved in the active environment is a
 * startup failure, not a surprise on the first user question. Agents name
 * LOGICAL profiles; the environment binds them (deploy/environments/<env>/
 * model-bindings.yaml renders SRE_MODEL_*), and an unbound profile means the
 * runtime would silently send the profile name to the provider as a model id.
 */
describe("model profiles fail closed", () => {
  const realLlm = {
    SRE_ENV: "local",
    SRE_CLIENT_LLM: "real",
    SRE_LLM_BASE_URL: "http://localhost:11434/v1",
  } as const;

  it("refuses to start a specialist whose profile is unbound in this environment", () => {
    expect(() => buildDependencies({ ...realLlm, AGENT_CONFIG: "config/agents/keycloak.yaml" }))
      .toThrow(/model profile\(s\) tool-caller cannot be resolved/u);
  });

  it("refuses to start a manager without a synthesis binding", () => {
    expect(() => buildDependencies({ ...realLlm, AGENT_CONFIG: "config/agents/manager.yaml", SRE_MODEL_MANAGER: "qwen3:8b" }))
      .toThrow(/model profile\(s\) tier-l-synthesis cannot be resolved/u);
  });

  it("starts once every referenced profile is bound", () => {
    expect(() => buildDependencies({ ...realLlm, AGENT_CONFIG: "config/agents/keycloak.yaml", SRE_MODEL_TOOL_CALLER: "qwen3:8b" })).not.toThrow();
  });
});
