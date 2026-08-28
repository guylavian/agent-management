import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { agentDeploymentOverlaySchema, loadDeploymentEnvironment, modelBindingsSchema, renderedAgentValuesSchema } from "@sre/config";

/**
 * config → renderer → rendered values → Argo CD → one Helm chart.
 *
 * These assertions guard the properties that make that path safe to automate:
 * the render is deterministic, it fails closed on an unbound model profile, and
 * the ApplicationSet discovers what was rendered rather than carrying its own
 * list of agents (which would be a second source of truth).
 */

const ENVIRONMENTS = readdirSync("deploy/environments").sort();
const APPLICATION_SET = readFileSync("deploy/argocd/applicationsets/runtime.yaml", "utf8");

function renderedFiles(environment: string): string[] {
  return readdirSync(`deploy/environments/${environment}/rendered/agents`).sort();
}

describe("deterministic render pipeline", () => {
  it("re-rendering produces byte-identical output", () => {
    const before = ENVIRONMENTS.flatMap((environment) =>
      renderedFiles(environment).map((file) => readFileSync(`deploy/environments/${environment}/rendered/agents/${file}`, "utf8")),
    );
    execFileSync("node", ["--import", "tsx", "scripts/render-agent-deployment.ts"], { stdio: "pipe" });
    const after = ENVIRONMENTS.flatMap((environment) =>
      renderedFiles(environment).map((file) => readFileSync(`deploy/environments/${environment}/rendered/agents/${file}`, "utf8")),
    );
    expect(after).toEqual(before);
  });

  it.each(ENVIRONMENTS)("%s rendered values satisfy the deployment schema", (environment) => {
    for (const file of renderedFiles(environment)) {
      const parsed = renderedAgentValuesSchema.safeParse(parseYaml(readFileSync(`deploy/environments/${environment}/rendered/agents/${file}`, "utf8")));
      expect(parsed.success, `${environment}/${file}: ${parsed.error?.message}`).toBe(true);
    }
  });

  it.each(ENVIRONMENTS)("%s binds every model profile its enabled agents reference", (environment) => {
    const bindings = modelBindingsSchema.parse(parseYaml(readFileSync(`deploy/environments/${environment}/model-bindings.yaml`, "utf8")));
    for (const file of renderedFiles(environment)) {
      const values = renderedAgentValuesSchema.parse(parseYaml(readFileSync(`deploy/environments/${environment}/rendered/agents/${file}`, "utf8")));
      expect(Object.keys(values.modelEnv).length).toBeGreaterThan(0);
      for (const model of Object.values(values.modelEnv)) {
        expect(Object.values(bindings.profiles).map((profile) => profile.model)).toContain(model);
      }
    }
  });

  it.each(ENVIRONMENTS)("%s renders exactly the agents the overlays enable", (environment) => {
    const state = loadDeploymentEnvironment(`deploy/environments/${environment}`);
    const expected = [...state.overlays.values()].filter((overlay) => overlay.enabled).map((overlay) => `${overlay.agentId}.yaml`);
    if (state.manager?.enabled) expected.push("manager.yaml");
    expect(renderedFiles(environment)).toEqual(expected.sort());
  });

  it("keeps ONE runtime chart and ONE image across every role", () => {
    const roles = new Set<string>();
    for (const environment of ENVIRONMENTS) {
      for (const file of renderedFiles(environment)) {
        const values = renderedAgentValuesSchema.parse(parseYaml(readFileSync(`deploy/environments/${environment}/rendered/agents/${file}`, "utf8")));
        roles.add(values.agent.mode);
        // no rendered file may pin its own image: the tag lives in the shared chart
        expect(Object.keys(values)).not.toContain("image");
      }
    }
    expect([...roles].sort()).toEqual(["manager", "specialist"]);
    expect(APPLICATION_SET).toContain("path: deploy/runtime/helm");
  });
});

describe("Argo CD ApplicationSet", () => {
  it("discovers rendered agents instead of listing them", () => {
    expect(APPLICATION_SET).toContain("deploy/environments/production/rendered/agents/*.yaml");
    expect(APPLICATION_SET).toContain("name: sre-agent-{{ .agent.name }}");
    // a config management plugin would render inside the cluster, letting the
    // committed and deployed states diverge with no reviewable diff
    const withoutComments = APPLICATION_SET.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    expect(withoutComments).not.toMatch(/^\s+plugin:/mu);
  });

  it("would instantiate a distinct Deployment for a newly rendered agent", () => {
    // the generator is file-driven, so this is a property of the file name
    const applicationName = APPLICATION_SET.match(/name: (sre-agent-\{\{ \.agent\.name \}\})/u)?.[1];
    expect(applicationName).toBeDefined();
    expect(applicationName?.replace("{{ .agent.name }}", "network-security")).toBe("sre-agent-network-security");
  });

  it("deploys into the namespace the endpoint convention assumes", () => {
    const settings = loadDeploymentEnvironment("deploy/environments/production").settings;
    expect(APPLICATION_SET).toContain(`namespace: ${settings.namespace}`);
    expect(settings.endpointTemplate).toContain("{namespace}");
  });
});

describe("deployment overlay schema is published", () => {
  it("mirrors the enforced Zod schema as an allow-list", () => {
    const schema = JSON.parse(readFileSync("deploy/schemas/agent-overlay.schema.json", "utf8")) as { additionalProperties?: boolean; properties?: Record<string, unknown> };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["agentId", "apiVersion", "enabled", "endpoint", "kind", "replicas", "resources", "serviceAccount"]);
    // the published schema must agree with the one the loader enforces
    expect(agentDeploymentOverlaySchema.safeParse({ apiVersion: "sre.ai/v1alpha1", kind: "AgentDeployment", agentId: "x", enabled: true, routing: {} }).success).toBe(false);
  });
});
