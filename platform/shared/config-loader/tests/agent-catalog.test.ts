import { readFileSync, readdirSync } from "node:fs";
import { agentDocumentSchema, type AgentDocument } from "@sre/agent-schema";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { agentDeploymentOverlaySchema, buildAgentCatalog, CONFIG_PATHS, DEPLOY_ROOT, deployEnvironmentDir, loadDeploymentEnvironment, loadEffectiveAgentCatalog, environmentSettingsSchema, resolveEndpoint } from "../src/index.ts";

const ENVIRONMENTS = readdirSync(`${DEPLOY_ROOT}/environments`);
const production = { ...CONFIG_PATHS, deploymentEnvironmentDir: deployEnvironmentDir("production") };

function canonicalDocuments(): AgentDocument[] {
  return readdirSync(CONFIG_PATHS.agentsDir)
    .filter((file) => file.endsWith(".yaml"))
    .map((file) => agentDocumentSchema.parse(parseYaml(readFileSync(`${CONFIG_PATHS.agentsDir}/${file}`, "utf8"))));
}

describe("effective agent catalog", () => {
  it("resolves logical IDs and filters by entitlement and environment", () => {
    const catalog = loadEffectiveAgentCatalog(production);
    expect(catalog.resolve("active-directory")?.endpoint).toContain("sre-agent-active-directory");
    expect(catalog.filterAuthorized(["active-directory", "network-observability"], ["infra-read"], "prod")).toEqual(["active-directory"]);
    expect(catalog.mayRequestDomain("active-directory", "network-observability")).toBe(true);
  });

  it("derives routing, ownership and authorization from the canonical Agent alone", () => {
    const catalog = loadEffectiveAgentCatalog(production);
    const keycloak = catalog.resolve("keycloak");
    expect(keycloak?.routing.exactTerms).toContain("keycloak realm");
    expect(keycloak?.requiredRoles).toEqual(["infra-read"]);
    expect(keycloak?.allowedNeedsDomains).toEqual(["observability"]);
    expect(keycloak?.owner).toBe("identity-platform");
  });

  /**
   * The point of the migration: onboarding an Agent is a config/agents edit plus
   * a deployment overlay, and NOTHING else. If a second logical registry ever
   * reappears, this fails — the new agent will not be routable without it.
   */
  it("routes a new canonical Agent without editing any other logical source", () => {
    const newAgent = agentDocumentSchema.parse({
      apiVersion: "sre.ai/v1alpha1",
      kind: "Agent",
      metadata: { name: "network-security", owner: "network-security", description: "Firewall policy and gateway state." },
      spec: {
        type: "specialist",
        lifecycle: "active",
        model: { tier: "small", profile: "tool-caller" },
        prompt: { systemFile: "config/prompts/network-security.md" },
        identity: { provider: "keycloak", clientId: "sre-agent-network-security" },
        environments: ["prod"],
        routing: { exactTerms: ["firewall policy"], capabilities: ["firewall rules"] },
        access: [{ mcp: "wiki", tools: ["wiki_search"] }],
        execution: { maxToolCalls: 6, maxModelTurns: 6, timeoutMs: 120000, maxEvidenceBytes: 262144, maxContextTokens: 12000, maxEvidenceItems: 32, maxRawExcerptBytes: 8192 },
        authorization: { requiredRoles: ["network-read"] },
      },
    });
    const environment = loadDeploymentEnvironment(deployEnvironmentDir("production"));
    const overlays = new Map(environment.overlays);
    overlays.set("network-security", agentDeploymentOverlaySchema.parse({ apiVersion: "sre.ai/v1alpha1", kind: "AgentDeployment", agentId: "network-security", enabled: true }));

    const catalog = buildAgentCatalog([...canonicalDocuments(), newAgent], environment.settings, overlays);
    const entry = catalog.resolve("network-security");
    expect(entry?.enabled).toBe(true);
    expect(entry?.routing.exactTerms).toEqual(["firewall policy"]);
    expect(entry?.endpoint).toBe("http://sre-agent-network-security.sre-assistant.svc.cluster.local");
    expect(catalog.listEnabled("prod").map((agent) => agent.agentId)).toContain("network-security");
  });

  it("uses the deterministic Service convention and honours an explicit override", () => {
    const settings = environmentSettingsSchema.parse({ apiVersion: "sre.ai/v1alpha1", kind: "DeploymentEnvironment", environment: "production", namespace: "sre-assistant" });
    expect(resolveEndpoint("network-security", settings)).toBe("http://sre-agent-network-security.sre-assistant.svc.cluster.local");
    const overridden = agentDeploymentOverlaySchema.parse({ apiVersion: "sre.ai/v1alpha1", kind: "AgentDeployment", agentId: "keycloak", enabled: true, endpoint: "http://127.0.0.1:3101" });
    expect(resolveEndpoint("keycloak", settings, overridden)).toBe("http://127.0.0.1:3101");
  });

  it("treats an Agent that is not deployed here as present but not routable", () => {
    const catalog = loadEffectiveAgentCatalog({ ...CONFIG_PATHS, deploymentEnvironmentDir: deployEnvironmentDir("poc") });
    // canonical, so a discovered domain naming it reads as "not deployed" rather than "unknown"
    expect(catalog.resolve("active-directory")).toBeDefined();
    expect(catalog.resolve("active-directory")?.enabled).toBe(false);
    expect(catalog.listEnabled("lab").map((agent) => agent.agentId).sort()).toEqual(["keycloak", "observability"]);
  });

  it("rejects a deployment overlay with no canonical Agent behind it", () => {
    expect(() => loadEffectiveAgentCatalog({ ...production, agentsDir: `${DEPLOY_ROOT}/environments` })).toThrow();
  });
});

describe("deployment overlays", () => {
  it.each(ENVIRONMENTS)("%s overlays carry deployment fields only", (environment) => {
    const directory = `${DEPLOY_ROOT}/environments/${environment}/agents`;
    for (const file of readdirSync(directory)) {
      const parsed = agentDeploymentOverlaySchema.safeParse(parseYaml(readFileSync(`${directory}/${file}`, "utf8")));
      expect(parsed.success, `${environment}/${file}: ${parsed.error?.message}`).toBe(true);
    }
  });

  /**
   * An allow-list, not a deny-list. Anything the schema does not name is
   * rejected, so an overlay cannot quietly become a second place where routing
   * or tool access is decided.
   */
  it.each([
    ["routing", { exactTerms: ["anything"] }],
    ["capabilities", ["something"]],
    ["exclusions", ["something"]],
    ["access", [{ mcp: "wiki", tools: ["wiki_search"] }]],
    ["owner", "someone-else"],
    ["prompt", { systemFile: "config/prompts/x.md" }],
    ["crossDomain", ["keycloak"]],
    ["tools", ["wiki_search"]],
  ])("rejects the logical field %s", (field, value) => {
    const parsed = agentDeploymentOverlaySchema.safeParse({ apiVersion: "sre.ai/v1alpha1", kind: "AgentDeployment", agentId: "keycloak", enabled: true, [field]: value });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
  });

  it("accepts exactly the approved deployment fields", () => {
    const parsed = agentDeploymentOverlaySchema.safeParse({
      apiVersion: "sre.ai/v1alpha1",
      kind: "AgentDeployment",
      agentId: "keycloak",
      enabled: true,
      replicas: 3,
      resources: { requests: { cpu: "500m", memory: "512Mi" }, limits: { cpu: "1", memory: "1Gi" } },
      serviceAccount: "sre-agent-keycloak",
      endpoint: "http://127.0.0.1:3101",
    });
    expect(parsed.success, parsed.error?.message).toBe(true);
  });
});
