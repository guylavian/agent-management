import { readFileSync } from "node:fs";
import { parse as parseYaml, parseAllDocuments } from "yaml";
import { describe, expect, it } from "vitest";
import { loadAgentRegistry, loadAppConfig, ConfigValidationError } from "../src/index.ts";

describe("startup configuration", () => {
  it("loads all four YAML agents and approved tools", () => {
    const registry = loadAgentRegistry({ agentsDir: "agents", promptsDir: "prompts", approvedCatalogFile: "policies/approved-tools.yaml" });
    expect(registry.manager.name).toBe("manager");
    expect(registry.listSpecialists().map((agent) => agent.name).sort()).toEqual(["active-directory", "network-observability", "openshift"]);
    expect(registry.getSpecialist("active-directory")?.spec.execution.maxEvidenceBytes).toBe(262_144);
    expect(registry.catalog.tools).toHaveLength(18);
  });

  it("publishes a strict JSON Schema", () => {
    const schema = JSON.parse(readFileSync("schemas/agent.schema.json", "utf8")) as { additionalProperties?: boolean; properties?: { spec?: { oneOf?: unknown[] } } };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.spec?.oneOf).toHaveLength(2);
  });

  it("fails closed when production selects a mock", () => {
    expect(() => loadAppConfig({ SRE_ENV: "production" })).toThrow(ConfigValidationError);
  });

  it("fails closed when a real endpoint is absent", () => {
    expect(() => loadAppConfig({ SRE_CLIENT_TOOLHIVE: "real" })).toThrow(/SRE_TOOLHIVE_URL/u);
  });

  it("validates evaluation and deployment YAML artifacts", () => {
    const corpus = parseYaml(readFileSync("eval/questions/cases.yaml", "utf8")) as { cases?: unknown[] };
    expect(corpus.cases).toHaveLength(60);
    for (const agent of ["manager", "active-directory", "openshift", "network-observability"]) {
      const parsed = parseYaml(readFileSync(`deploy/helm/values/${agent}.yaml`, "utf8")) as { agent: { name: string } };
      expect(parseAllDocuments(readFileSync(`deploy/helm/values/${agent}.yaml`, "utf8")).every((document) => document.errors.length === 0)).toBe(true);
      expect(parsed.agent.name).toBe(agent);
    }
    expect(parseYaml(readFileSync("deploy/helm/Chart.yaml", "utf8"))).toMatchObject({ apiVersion: "v2", name: "sre-agent-runtime", version: "0.2.0" });
    expect(parseYaml(readFileSync("deploy/helm/values.yaml", "utf8"))).toMatchObject({ image: { tag: "0.2.0" }, agent: { mode: "manager" } });
  });
});
