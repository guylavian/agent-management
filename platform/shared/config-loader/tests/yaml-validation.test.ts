import { readFileSync, readdirSync } from "node:fs";
import { parse as parseYaml, parseAllDocuments } from "yaml";
import { describe, expect, it } from "vitest";
import { agentDocumentSchema, assertNoSecretMaterial } from "@sre/agent-schema";
import { accessTools, CONFIG_PATHS, ConfigValidationError, DEPLOY_ROOT, deployEnvironmentDir, loadAgentRegistry, loadDeploymentEnvironment, loadAppConfig, loadApprovedCatalog, loadModelProfiles, loadToolPolicy, renderedAgentValuesSchema, validateSemantics } from "../src/index.ts";

describe("startup configuration", () => {
  it("loads all specialist YAML agents and approved tools", () => {
    const registry = loadAgentRegistry(CONFIG_PATHS);
    expect(registry.manager.name).toBe("manager");
    // every canonical document except the Manager, derived rather than listed
    const onDisk = readdirSync(CONFIG_PATHS.agentsDir)
      .filter((file) => file.endsWith(".yaml") && file !== "manager.yaml")
      .map((file) => file.replace(/\.yaml$/u, ""))
      .sort();
    expect(registry.listSpecialists().map((agent) => agent.name).sort()).toEqual(onDisk);
    // wiki is a shared MCP tool on the specialists, not a standalone agent
    expect(accessTools(registry.getSpecialist("active-directory")!.spec)).toContain("wiki_search");
    expect(registry.getSpecialist("active-directory")?.spec.execution.maxEvidenceBytes).toBe(262_144);
    // The catalog is every per-server file flattened, so assert THAT rather than
    // a total. A literal count here fails on any routine tool approval, which
    // teaches whoever hits it to bump the number without reading the assertion.
    const serverFiles = readdirSync(CONFIG_PATHS.mcpServersDir).filter((file) => file.endsWith(".yaml"));
    const declared = serverFiles.flatMap((file) => {
      const document = parseYaml(readFileSync(`${CONFIG_PATHS.mcpServersDir}/${file}`, "utf8")) as { metadata: { serverId: string }; tools: unknown[] };
      return document.tools.map(() => document.metadata.serverId);
    });
    expect(registry.catalog.tools).toHaveLength(declared.length);
    expect(new Set(registry.catalog.tools.map((tool) => tool.serverId))).toEqual(new Set(declared));
    // fail-closed: a mutating tool cannot be in the catalog at all
    expect(registry.catalog.tools.every((tool) => tool.readOnlyVerified)).toBe(true);
    expect(accessTools(registry.getSpecialist("active-directory")!.spec)).not.toContain("keycloak_health");
    expect(accessTools(registry.getSpecialist("keycloak")!.spec)).toContain("keycloak_health");
    expect(accessTools(registry.getSpecialist("observability")!.spec)).toContain("query");
    // every specialist carries its own workload identity — never a shared one
    const clientIds = registry.listSpecialists().map((agent) => agent.spec.identity.clientId);
    expect(new Set(clientIds).size).toBe(clientIds.length);
    expect(clientIds).toContain("sre-agent-keycloak");
    expect(registry.catalog.tools.filter((tool) => tool.serverId === "wiki").every((tool) => tool.evidenceKind === "wiki")).toBe(true);
  });

  it("declares every model profile an Agent references", () => {
    const profiles = loadModelProfiles(CONFIG_PATHS.modelProfilesFile);
    const declared = new Set(profiles.profiles.map((profile) => profile.id));
    const registry = loadAgentRegistry(CONFIG_PATHS);
    for (const agent of [registry.manager, ...registry.listSpecialists()]) {
      expect(declared, agent.name).toContain(agent.spec.model.profile);
    }
  });

  it("rejects an Agent naming an undeclared model profile", () => {
    // the profile registry is the only place a profile can be introduced;
    // an Agent cannot invent one and discover the gap at request time
    expect(() => validateSemantics(
      [{ file: "invented.yaml", doc: agentDocumentSchema.parse({
        apiVersion: "sre.ai/v1alpha1",
        kind: "Agent",
        metadata: { name: "manager", owner: "sre-platform" },
        spec: {
          type: "manager",
          model: { tier: "small", profile: "no-such-profile" },
          prompt: { systemFile: "config/prompts/manager.md" },
          execution: { maxAgentsPerRequest: 3, maxRounds: 1, timeoutMs: 1500 },
          output: { schema: "ManagerDecision" },
        },
      }) }],
      loadApprovedCatalog(CONFIG_PATHS.mcpServersDir),
      loadModelProfiles(CONFIG_PATHS.modelProfilesFile),
      loadToolPolicy(CONFIG_PATHS.toolPolicyFile),
    )).toThrow(/model profile "no-such-profile" is not declared/u);
  });

  it("rejects an approved tool whose name reads as a mutation", () => {
    const catalog = loadApprovedCatalog(CONFIG_PATHS.mcpServersDir);
    const mutating = { ...catalog, tools: [...catalog.tools, { ...catalog.tools[0]!, toolName: "delete_realm" }] };
    expect(() => validateSemantics([], mutating, loadModelProfiles(CONFIG_PATHS.modelProfilesFile), loadToolPolicy(CONFIG_PATHS.toolPolicyFile)))
      .toThrow(/forbidden mutating prefix "delete_"/u);
  });

  it("publishes a strict JSON Schema", () => {
    const schema = JSON.parse(readFileSync("contracts/agent-schema/generated/agent.schema.json", "utf8")) as { additionalProperties?: boolean; properties?: { spec?: { oneOf?: unknown[] } } };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.spec?.oneOf).toHaveLength(2);
  });

  it("fails closed when production selects a mock", () => {
    expect(() => loadAppConfig({ SRE_ENV: "production" })).toThrow(ConfigValidationError);
  });

  it("fails closed when real-poc selects any mock runtime dependency", () => {
    expect(() => loadAppConfig({ SRE_ENV: "real-poc" })).toThrow(/mock in real-poc/u);
  });

  it("accepts only an explicitly real/disabled real-poc dependency set", () => {
    const config = loadAppConfig({
      SRE_ENV: "real-poc",
      SRE_CLIENT_OIDC: "real",
      SRE_CLIENT_LLM: "real",
      SRE_CLIENT_TOOLHIVE: "real",
      SRE_CLIENT_POSTGRES: "disabled",
      SRE_CLIENT_AGENT: "real",
      SRE_CLIENT_DELEGATION: "real",
      SRE_OIDC_JWKS_URI: "http://localhost/idp/jwks",
      SRE_INTERNAL_OIDC_JWKS_URI: "http://localhost/idp/jwks",
      SRE_LLM_BASE_URL: "http://localhost:11434",
      SRE_TOOLHIVE_ENDPOINTS_JSON: '{"keycloak":"http://localhost:8301/mcp"}',
      SRE_TOOL_CREDENTIAL_STRATEGY: "signed-jwt",
      SRE_TOOL_CREDENTIAL_PRIVATE_KEY_FILE: ".real-poc/private.pem",
      SRE_WORKLOAD_TOKEN_ENDPOINT: "http://localhost/idp/token",
      SRE_WORKLOAD_CLIENT_ID: "manager",
      SRE_WORKLOAD_CLIENT_SECRET: "secret",
      SRE_DELEGATION_PUBLIC_KEY_FILE: ".real-poc/public.pem",
    });
    expect(config.env).toBe("real-poc");
    expect(Object.values(config.clients)).not.toContain("mock");
  });

  it("fails closed when a real endpoint is absent", () => {
    expect(() => loadAppConfig({ SRE_CLIENT_TOOLHIVE: "real" })).toThrow(/SRE_TOOLHIVE_URL/u);
  });

  it("validates evaluation and deployment YAML artifacts", () => {
    const corpus = parseYaml(readFileSync("eval/questions/cases.yaml", "utf8")) as { cases?: unknown[] };
    expect(corpus.cases).toHaveLength(60);
    for (const agent of ["manager", "active-directory", "openshift", "network-observability", "keycloak", "observability"]) {
      const file = `${DEPLOY_ROOT}/environments/production/rendered/agents/${agent}.yaml`;
      expect(parseAllDocuments(readFileSync(file, "utf8")).every((document) => document.errors.length === 0)).toBe(true);
      const parsed = renderedAgentValuesSchema.parse(parseYaml(readFileSync(file, "utf8")));
      expect(parsed.agent.name).toBe(agent);
    }
    expect(parseYaml(readFileSync("../deploy/runtime/helm/Chart.yaml", "utf8"))).toMatchObject({ apiVersion: "v2", name: "sre-agent-runtime", version: "0.2.0" });
    expect(parseYaml(readFileSync("../deploy/runtime/helm/values.yaml", "utf8"))).toMatchObject({ image: { tag: "0.2.0" }, agent: { mode: "manager" } });
  });

  /**
   * Rendered values are the deployment interface, so they must stay
   * credential-free: only references to a secret source may appear.
   */
  it("renders no credential material into any environment", () => {
    for (const environment of readdirSync(`${DEPLOY_ROOT}/environments`)) {
      const directory = `${DEPLOY_ROOT}/environments/${environment}/rendered/agents`;
      for (const file of readdirSync(directory)) {
        const contents = readFileSync(`${directory}/${file}`, "utf8");
        /*
         * The raw scan skips COMMENT lines, and only comment lines.
         *
         * Rendered values now embed Agent documents, prompts and environment
         * files verbatim, so that Argo can deliver desired state to a running
         * pod. Those files carry prose, and prose legitimately NAMES
         * credentials — `SRE_LLM_API_KEY comes from .env.real-poc` is
         * documentation, not a key. A comment is also inert: nothing loads it.
         *
         * What is NOT relaxed is the check on data. Every non-comment line is
         * still scanned, `assertNoSecretMaterial` still walks the parsed
         * structure below, and the SOURCE files are independently covered by
         * `validate:tracked`. Widening the regex to please an embedded comment
         * would have been the wrong trade; this narrows what it reads instead.
         */
        const data = contents.split("\n").filter((line) => !/^\s*#/u.test(line)).join("\n");
        expect(data, `${environment}/${file}`).not.toMatch(/client[_-]?secret|password|private[_-]?key|api[_-]?key|bearer |access[_-]?token|refresh[_-]?token/iu);
        assertNoSecretMaterial(parseYaml(contents), `${environment}/${file}`);
      }
    }
  });

  it("renders one values file per ENABLED agent and none for the rest", () => {
    // absence is how "do not deploy this here" reaches the ApplicationSet,
    // which discovers files rather than reading an enablement list
    // Derived from the overlays rather than listed: a literal list fails whenever
    // an environment enables or disables an agent, which is a routine deployment
    // change, and teaches whoever hits it to edit the list instead of the claim.
    for (const environment of ["poc", "local", "production"]) {
      const rendered = readdirSync(`${DEPLOY_ROOT}/environments/${environment}/rendered/agents`).sort();
      const overlays = loadDeploymentEnvironment(deployEnvironmentDir(environment)).overlays;
      const expected = [...overlays.values()].filter((overlay) => overlay.enabled).map((overlay) => `${overlay.agentId}.yaml`);
      expect(rendered, environment).toEqual([...expected, "manager.yaml"].sort());
    }
  });
});
