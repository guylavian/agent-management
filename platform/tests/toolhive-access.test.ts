import { readFileSync, readdirSync } from "node:fs";
import { CONFIG_PATHS, DEPLOY_ROOT, deployEnvironmentDir, loadAgentRegistry, loadApprovedCatalog, loadDeploymentEnvironment } from "@sre/config";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { grantsByServer, renderAuthzConfig } from "../tools/render-toolhive-authz.ts";

/**
 * Agent → MCP → tool access as ToolHive actually enforces it.
 *
 * The runtime already enforces its own allowlist. This is the SECOND, independent
 * bound: even a specialist that somehow asked for a tool outside its policy is
 * refused at the gateway, because Cedar is default-deny and the policy is derived
 * from the same canonical Agent configuration.
 *
 * Defense in depth means neither layer may be removed because the other exists.
 */

const ENVIRONMENTS = readdirSync(`${DEPLOY_ROOT}/environments`).sort();
const catalog = loadApprovedCatalog(CONFIG_PATHS.mcpServersDir);
// the canonical estate, whatever it happens to contain today
const specialists = loadAgentRegistry(CONFIG_PATHS).listSpecialists();

function policiesFor(environment: string, serverId: string): string[] {
  const parsed = parseYaml(readFileSync(`${DEPLOY_ROOT}/environments/${environment}/rendered/toolhive/${serverId}.authz.yaml`, "utf8")) as {
    type: string;
    cedar: { policies: string[] };
  };
  expect(parsed.type).toBe("cedarv1");
  return parsed.cedar.policies;
}

describe("ToolHive access policy", () => {
  it.each(ENVIRONMENTS)("%s renders one policy file per approved MCP server", (environment) => {
    const servers = [...new Set(catalog.tools.map((tool) => tool.serverId))].sort();
    const rendered = readdirSync(`${DEPLOY_ROOT}/environments/${environment}/rendered/toolhive`).map((file) => file.replace(".authz.yaml", "")).sort();
    expect(rendered).toEqual(servers);
  });

  /**
   * DERIVED FROM THE CANONICAL POLICY, never from a list written here.
   *
   * This used to name the seven tools one agent holds on the keycloak MCP and
   * assert the file had exactly that many policies. Adding any OTHER agent with
   * keycloak access then failed a test about tool grants — reporting a
   * correctly rendered policy as a defect, because the expectation was a copy
   * of the estate as it stood on the day it was written.
   *
   * The invariant is a BIJECTION: one Cedar policy per (agent, tool) grant in
   * the canonical documents — nothing missing, and nothing granted that no
   * Agent document asks for. That holds for any estate.
   */
  it.each(["keycloak", "wiki"])("grants exactly the (agent, tool) pairs the canonical policy allows on %s", (serverId) => {
    const policies = policiesFor("production", serverId);
    const expected = specialists.flatMap((agent) =>
      (agent.spec.access.find((entry) => entry.mcp === serverId)?.tools ?? []).map((tool) => ({ clientId: agent.spec.identity.clientId, tool })),
    );
    expect(expected.length).toBeGreaterThan(0);
    for (const { clientId, tool } of expected) {
      expect(
        policies.some((policy) => policy.includes(`Tool::"${tool}"`) && policy.includes(`claim_azp == "${clientId}"`)),
        `${serverId}: no policy grants ${clientId} the ${tool} tool`,
      ).toBe(true);
    }
    // and NOTHING beyond them: a policy with no canonical grant behind it is
    // exactly the drift this file exists to catch
    expect(policies).toHaveLength(expected.length);
  });

  /**
   * The identity in the policy is the AGENT WORKLOAD (`azp`), not the human
   * (`sub`). Keying on the human would authorize a person to a tool, which is a
   * different question from authorizing an Agent to a tool.
   */
  it("scopes on the Agent workload, never the human subject", () => {
    for (const environment of ENVIRONMENTS) {
      for (const file of readdirSync(`${DEPLOY_ROOT}/environments/${environment}/rendered/toolhive`)) {
        for (const policy of policiesFor(environment, file.replace(".authz.yaml", ""))) {
          // the blanket forbid names no principal at all, which is the point of it
          if (policy.startsWith("forbid(")) continue;
          expect(policy).toContain("principal.claim_azp ==");
          expect(policy).not.toContain("claim_sub");
        }
      }
    }
  });

  /**
   * ToolHive refuses to start a proxy whose policy set is empty ("no policies
   * loaded"), so a server nobody may reach carries an explicit blanket forbid.
   * An unloadable policy is not a denial, it is an outage.
   */
  it("explicitly forbids everything on a server no Agent may reach here", () => {
    // active-directory is canonical but not deployed in the PoC environment, so
    // the only Agent that may reach its MCP server contributes no permit
    expect(policiesFor("poc", "active-directory")).toEqual(["forbid(principal, action, resource);"]);
    expect(loadDeploymentEnvironment(deployEnvironmentDir("poc")).overlays.get("active-directory")?.enabled).toBe(false);
  });

  /**
   * Cedar ERRORS rather than denying when a policy reads an attribute the
   * principal lacks, so an unguarded `principal.claim_azp` turns a token without
   * `azp` into an authorization error instead of a clean deny.
   */
  it("guards every claim read so a missing claim denies rather than errors", () => {
    for (const environment of ENVIRONMENTS) {
      for (const file of readdirSync(`${DEPLOY_ROOT}/environments/${environment}/rendered/toolhive`)) {
        for (const policy of policiesFor(environment, file.replace(".authz.yaml", ""))) {
          if (!policy.includes("claim_azp")) continue;
          expect(policy, `${environment}/${file}`).toContain("principal has claim_azp &&");
        }
      }
    }
  });

  it("drops an Agent that is not deployed in the environment", () => {
    const poc = grantsByServer("poc");
    const wikiAgents = (poc.get("wiki") ?? []).map((grant) => grant.agentId).sort();
    expect(wikiAgents).toEqual(["keycloak", "observability", "openshift"]);
    // the same Agents that the Manager's effective catalog will route to
    expect((poc.get("network") ?? [])).toEqual([]);
  });

  it("refuses to render a grant for a tool the platform never approved", () => {
    expect(() =>
      renderAuthzConfig("keycloak", [{ workloadClientId: "sre-agent-keycloak", agentId: "keycloak", tools: ["delete_realm"], audience: "sre-toolhive:keycloak" }], new Set(["list_realms"])),
    ).toThrow(/unapproved tool delete_realm/u);
  });

  it("refuses to render an identifier that could escape the policy string", () => {
    expect(() =>
      renderAuthzConfig("keycloak", [{ workloadClientId: 'sre-agent-x"; permit(principal, action, resource); //', agentId: "x", tools: ["list_realms"], audience: "a" }], new Set(["list_realms"])),
    ).toThrow(/unexpected identifier/u);
  });

  it("is deterministic", () => {
    const first = renderAuthzConfig("wiki", grantsByServer("production").get("wiki") ?? [], new Set(["wiki_search", "wiki_read_page", "wiki_route"]));
    const second = renderAuthzConfig("wiki", grantsByServer("production").get("wiki") ?? [], new Set(["wiki_search", "wiki_read_page", "wiki_route"]));
    expect(first).toBe(second);
  });

  it("keeps one proxy per MCP server — access is a policy on it, not a copy of it", () => {
    const script = readFileSync("tools/start-real-poc.sh", "utf8");
    const runs = [...script.matchAll(/^run_proxy .*$/gmu)].map((match) => match[0]);
    const names = runs.map((line) => line.split(/\s+/u)[2]);
    expect(new Set(names).size).toBe(names.length);
    // every proxy is started with a rendered policy, not with tool filtering alone
    expect(script).toContain("--authz-config");
  });
});
