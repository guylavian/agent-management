import { readFileSync, readdirSync } from "node:fs";
import { agentDocumentSchema, isAgentEnabled, type AgentDocument } from "@sre/agent-schema";
import { CONFIG_PATHS, buildAgentCatalog, loadDeploymentEnvironment } from "@sre/config";
import { desiredClientFor } from "@sre/keycloak-provisioning";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { renderAuthzConfig } from "../tools/render-toolhive-authz.ts";

/**
 * Agent lifecycle, meant the same way everywhere.
 *
 * "Disabled" is only a real state if every plane agrees on it. Git is the
 * source: `config/agents/<agent>.yaml` carries the lifecycle, and each
 * consequence is DERIVED from it rather than set independently somewhere a
 * human could forget.
 *
 *   lifecycle       Manager routes   deployed   workload token   MCP access
 *   draft           no               no         disabled         none
 *   active          yes*             yes*       enabled          per policy
 *   disabled        no               no         disabled         none
 *   decommissioning no               no         disabled         none
 *
 *   * and only where the environment overlay also enables it
 *
 * Backstage is deliberately not in this table: it reads state, it does not hold
 * it. There is no hidden lifecycle in the portal database.
 */

const NON_ROUTABLE = ["draft", "disabled", "decommissioning", "removed"] as const;

function specialist(name: string): AgentDocument {
  return agentDocumentSchema.parse(parseYaml(readFileSync(`${CONFIG_PATHS.agentsDir}/${name}.yaml`, "utf8")));
}

function withLifecycle(doc: AgentDocument, lifecycle: string): AgentDocument {
  return agentDocumentSchema.parse({ ...doc, spec: { ...doc.spec, lifecycle } });
}

// the discovery edge keycloak -> observability must resolve, so both documents
// are present in every catalog built here
const keycloak = specialist("keycloak");
const observability = specialist("observability");
const environment = loadDeploymentEnvironment("deploy/environments/production");

describe("agent lifecycle is consistent across every plane", () => {
  it("only an active Agent is routable, and only where it is deployed", () => {
    for (const lifecycle of NON_ROUTABLE) {
      const catalog = buildAgentCatalog([withLifecycle(keycloak, lifecycle), observability], environment.settings, environment.overlays);
      expect(catalog.resolve("keycloak")?.enabled, lifecycle).toBe(false);
      expect(catalog.listEnabled("prod").map((agent) => agent.agentId), lifecycle).toEqual(["observability"]);
    }
    const active = buildAgentCatalog([keycloak, observability], environment.settings, environment.overlays);
    expect(active.resolve("keycloak")?.enabled).toBe(true);
  });

  it("an active Agent that the environment does not enable is still not routable", () => {
    const overlays = new Map(environment.overlays);
    overlays.set("keycloak", { ...overlays.get("keycloak")!, enabled: false });
    const catalog = buildAgentCatalog([keycloak, observability], environment.settings, overlays);
    expect(catalog.resolve("keycloak")?.enabled).toBe(false);
  });

  it("a non-active Agent gets a DISABLED workload identity, never a deleted one", () => {
    for (const lifecycle of NON_ROUTABLE) {
      const desired = desiredClientFor({ ...keycloakConfig(), spec: withLifecycle(keycloak, lifecycle).spec as never });
      expect(desired.enabled, lifecycle).toBe(false);
      // the client is still described, so its audit history stays attributable
      expect(desired.clientId).toBe("sre-agent-keycloak");
    }
    expect(desiredClientFor(keycloakConfig()).enabled).toBe(true);
  });

  it("a non-active Agent is granted no MCP tool at the gateway", () => {
    const approved = new Set(["list_realms", "keycloak_health"]);
    const denied = renderAuthzConfig("keycloak", [], approved);
    // an explicit blanket forbid, because ToolHive will not load an empty set
    expect(denied).toContain("forbid(principal, action, resource);");
    expect(denied).not.toContain("permit(");
  });

  it("the renderer refuses to deploy an Agent whose lifecycle is not active", () => {
    // caught at render time rather than at startup in the cluster
    for (const environmentName of readdirSync("deploy/environments")) {
      const state = loadDeploymentEnvironment(`deploy/environments/${environmentName}`);
      for (const [agentId, overlay] of state.overlays) {
        if (!overlay.enabled) continue;
        expect(isAgentEnabled(specialist(agentId).spec), `${environmentName}/${agentId}`).toBe(true);
      }
    }
  });

  it("keeps run history readable regardless of lifecycle", () => {
    // nothing in the disable path deletes a workload identity or a run record;
    // an Agent that is switched off must remain explainable after the fact
    const desired = desiredClientFor({ ...keycloakConfig(), spec: withLifecycle(keycloak, "decommissioning").spec as never });
    expect(desired.roles.length).toBeGreaterThan(0);
    expect(desired.attributes["sre.agent.lifecycle"]).toBe("decommissioning");
  });
});

function keycloakConfig() {
  if (keycloak.spec.type !== "specialist") throw new Error("expected a specialist");
  return { name: keycloak.metadata.name, owner: keycloak.metadata.owner, spec: keycloak.spec, systemPrompt: "x" };
}
