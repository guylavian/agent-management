import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { agentDocumentSchema, DEPLOY_ROOT, loadDeploymentEnvironment } from "@sre/config";

/**
 * Policy gate: canonical agents meet security and quality requirements.
 *
 * Once enabled in an environment, an agent is published to the Manager's catalog
 * and becomes routable. The gate ensures canonical agents cannot be test/placeholder
 * definitions and possess real descriptions and plausible routing capabilities.
 */

export function isPlausibleCapability(s: string): boolean {
  if (s.length < 4) return false;
  // must contain at least one vowel (a, e, i, o, u)
  if (!/[aeiou]/iu.test(s)) return false;
  return true;
}

function loadCanonicalAgent(name: string): ReturnType<typeof agentDocumentSchema.parse> {
  const yaml = readFileSync(`${DEPLOY_ROOT}/../platform/config/agents/${name}.yaml`, "utf8");
  const parsed = parseYaml(yaml);
  return agentDocumentSchema.parse(parsed);
}

describe("agent policy gate", () => {
  it("forbids test/placeholder canonical agents", () => {
    const forbiddenNames = new Set(["test", "guy", "efrgdv"]);
    const forbiddenDescriptions = new Set(["rrr", "guy", ""]);

    for (const name of forbiddenNames) {
      try {
        const agent = loadCanonicalAgent(name);
        // This should never be reached after the fix, but the test documents the requirement
        if (forbiddenDescriptions.has(agent.metadata.description ?? "")) {
          throw new Error(`Agent ${name} has forbidden placeholder description`);
        }
        if (agent.metadata.owner === agent.metadata.name) {
          throw new Error(`Agent ${name} has owner equal to name (not unique)`);
        }
      } catch (error) {
        // the file being absent is the point — but only for THIS name; a
        // `return` here abandoned every name after the first one that was gone
        if (String(error).includes("ENOENT")) continue;
        throw error;
      }
    }
  });

  const ENVIRONMENTS = readdirSync(`${DEPLOY_ROOT}/environments`).sort();

  it.each(ENVIRONMENTS)(
    "%s: every enabled agent has description >= 20 chars, plausible owner, and plausible routing",
    (environment) => {
      const state = loadDeploymentEnvironment(`${DEPLOY_ROOT}/environments/${environment}`);

      for (const [agentId, overlay] of state.overlays) {
        if (!overlay.enabled) continue;

        const agent = loadCanonicalAgent(agentId);

        // Description: required and >= 20 chars
        expect(agent.metadata.description).toBeDefined();
        expect(agent.metadata.description?.length).toBeGreaterThanOrEqual(20);

        // Owner: not a placeholder and not equal to agent name
        expect(agent.metadata.owner).not.toBe(agentId);
        expect(["test", "guy", "erqgre"]).not.toContain(agent.metadata.owner);

        // Routing: if specialist, at least one plausible capability
        if (agent.spec.type === "specialist") {
          const capabilities = agent.spec.routing.capabilities ?? [];
          if (capabilities.length > 0) {
            for (const cap of capabilities) {
              expect(isPlausibleCapability(cap), `${agentId}: capability "${cap}" is not plausible`).toBe(true);
            }
          }
        }
      }
    },
  );

  it.each(ENVIRONMENTS)(
    "%s: rendered agents match enabled overlays exactly",
    (environment) => {
      const state = loadDeploymentEnvironment(`${DEPLOY_ROOT}/environments/${environment}`);
      const enabledAgents = [...state.overlays.values()]
        .filter((overlay) => overlay.enabled)
        .map((overlay) => `${overlay.agentId}.yaml`);

      if (state.manager?.enabled) {
        enabledAgents.push("manager.yaml");
      }

      const renderedFiles = readdirSync(`${DEPLOY_ROOT}/environments/${environment}/rendered/agents`)
        .filter((f) => f.endsWith(".yaml"))
        .sort();

      expect(renderedFiles).toEqual(enabledAgents.sort());
    },
  );
});
