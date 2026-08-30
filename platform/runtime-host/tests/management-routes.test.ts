import { describe, expect, it } from "vitest";
import { CONFIG_PATHS, loadAgentRegistry } from "@sre/config";
import { buildDependencies, createApp, type ManagerDependencies, type TestableApp } from "@sre/runtime-host";

/**
 * HTTP-level contract for the management plane (TDD §43/§57).
 * These assert the boundary the portal actually talks to: authentication is
 * required, nothing mutates production, and no credential crosses the wire.
 */

const MANAGER_ENV = {
  SRE_ENV: "local",
  AGENT_CONFIG: "config/agents/manager.yaml",
  SRE_CLIENT_AGENT: "mock",
};

async function managerApp(): Promise<{ app: TestableApp; token: string; deps: ManagerDependencies }> {
  const deps = buildDependencies(MANAGER_ENV) as ManagerDependencies;
  const app = createApp(deps);
  const issued = await app.inject({ method: "POST", url: "/dev/token/alice" });
  return { app, token: (issued.json() as { token: string }).token, deps };
}

async function get(app: TestableApp, url: string, token?: string) {
  return app.inject({ method: "GET", url, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
}

describe("management API", () => {
  it("requires authentication", async () => {
    const { app } = await managerApp();
    expect((await get(app, "/management/agents")).statusCode).toBe(401);
    expect((await get(app, "/management/permissions")).statusCode).toBe(401);
  });

  it("lists agents from the canonical config", async () => {
    const { app, token } = await managerApp();
    const response = await get(app, "/management/agents", token);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { agents: Array<{ id: string; workloadClientId: string }> };
    // derived, not listed: adding an Agent is a routine config change, and a
    // literal roster here fails on every one of them
    expect(body.agents.map((agent) => agent.id).sort()).toEqual(loadAgentRegistry(CONFIG_PATHS).listSpecialists().map((agent) => agent.name).sort());
    expect(body.agents.every((agent) => agent.workloadClientId === `sre-agent-${agent.id}`)).toBe(true);
  });

  it("returns agent detail with denied MCPs shown explicitly", async () => {
    const { app, token } = await managerApp();
    const body = (await get(app, "/management/agents/keycloak", token)).json() as { access: Array<{ mcp: string; allowed: boolean }> };
    expect(body.access.find((entry) => entry.mcp === "keycloak")?.allowed).toBe(true);
    expect(body.access.find((entry) => entry.mcp === "prometheus")?.allowed).toBe(false);
  });

  it("404s an unknown agent", async () => {
    const { app, token } = await managerApp();
    expect((await get(app, "/management/agents/nope", token)).statusCode).toBe(404);
  });

  it("reports metrics as not-configured rather than inventing them", async () => {
    const { app, token } = await managerApp();
    const body = (await get(app, "/management/agents/keycloak/metrics", token)).json() as { status?: string };
    expect(body.status).toBe("not-configured");
  });

  it("reports reachability as unknown rather than claiming healthy", async () => {
    const { app, token } = await managerApp();
    const body = (await get(app, "/management/agents/keycloak/health", token)).json() as { reachability: string; lifecycle: string };
    expect(body.reachability).toBe("unknown");
    expect(body.lifecycle).toBe("active");
  });

  it("reports evaluations as not-configured", async () => {
    const { app, token } = await managerApp();
    expect((await get(app, "/management/evaluations", token)).json()).toMatchObject({ status: "not-configured" });
  });

  it("serves the permissions matrix consistent with the runtime policy", async () => {
    const { app, token } = await managerApp();
    const body = (await get(app, "/management/permissions", token)).json() as { mcps: string[]; rows: Array<{ agent: string; cells: Array<{ mcp: string; allowed: boolean }> }> };
    const keycloakRow = body.rows.find((row) => row.agent === "keycloak")!;
    expect(keycloakRow.cells.find((cell) => cell.mcp === "prometheus")?.allowed).toBe(false);
    expect(keycloakRow.cells.find((cell) => cell.mcp === "wiki")?.allowed).toBe(true);
  });

  it("never returns a token, secret or credential anywhere in the management surface", async () => {
    const { app, token } = await managerApp();
    for (const url of ["/management/agents", "/management/agents/keycloak", "/management/mcp-servers", "/management/permissions", "/management/runs"]) {
      const payload = (await get(app, url, token)).payload;
      expect(payload).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/u);
      expect(payload).not.toMatch(/"(client_?secret|password|privateKey|api_?key)"/iu);
    }
  });
});

describe("GitOps change flow", () => {
  const draft = {
    name: "check-point",
    owner: "network-security",
    displayName: "Check Point Agent",
    modelTier: "small",
    modelProfile: "tool-caller",
    prompt: "You are the Check Point specialist. Investigate firewall policy and gateway state using only approved read-only tools.",
    requiredRoles: ["network-read"],
    access: [{ mcp: "wiki", tools: ["wiki_search", "wiki_read_page"] }],
  };

  async function post(app: TestableApp, url: string, token: string, body: unknown) {
    return app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: JSON.stringify(body) });
  }

  it("previews canonical YAML without changing anything", async () => {
    const { app, token, deps } = await managerApp();
    const before = deps.desiredState.current().registry.listSpecialists().length;
    const response = await post(app, "/management/agents/preview", token, draft);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { path: string; yaml: string; effects: string[] };
    expect(body.path).toBe("config/agents/check-point.yaml");
    expect(body.yaml).toContain("clientId: sre-agent-check-point");
    expect(body.yaml).toContain("audience: sre-toolhive:wiki");
    expect(body.effects.some((effect) => effect.includes("Keycloak"))).toBe(true);
    expect(deps.desiredState.current().registry.listSpecialists().length).toBe(before);
  });

  it("rejects an invalid draft with issues instead of generating a file", async () => {
    const { app, token } = await managerApp();
    const response = await post(app, "/management/agents/preview", token, { ...draft, name: "Check Point" });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { code: string }).code).toBe("AGENT_DRAFT_INVALID");
  });

  it("never emits a secret into the generated YAML", async () => {
    const { app, token } = await managerApp();
    const body = (await post(app, "/management/agents/preview", token, draft)).json() as { yaml: string };
    expect(body.yaml).not.toMatch(/secret|password|token:|private[_-]?key/iu);
  });

  /**
   * The runtime renders a change-set and cannot publish one. Writing moved to
   * the management plane so the process that ENFORCES Agent policy cannot also
   * CHANGE it, and holds no Git credential that would let it try.
   */
  it("exposes no endpoint that writes a change", async () => {
    const { app, token } = await managerApp();
    for (const url of ["/management/agents/change", "/management/agents/commit", "/management/agents/pr"]) {
      expect((await post(app, url, token, draft)).statusCode, url).toBe(404);
    }
  });

  it("renders everything the management plane needs to open the pull request", async () => {
    const { app, token } = await managerApp();
    const body = (await post(app, "/management/agents/preview", token, draft)).json() as { branch: string; title: string; body: string; files: Array<{ path: string }> };
    expect(body.branch).toBe("agent/add-check-point");
    expect(body.title).toContain("check-point");
    expect(body.body).toContain("Workload identity");
    // document, prompt, overlay, and the render Argo's ApplicationSet globs
    expect(body.files.map((file) => file.path)).toHaveLength(4);
    expect(body.files.map((file) => file.path)).toContainEqual(expect.stringContaining("/rendered/agents/"));
  });

  it("exposes no endpoint that deploys to production", async () => {
    const { app, token } = await managerApp();
    for (const url of ["/management/agents/keycloak/deploy", "/management/deploy", "/management/agents/keycloak/apply"]) {
      const response = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode).toBe(404);
    }
  });
});
