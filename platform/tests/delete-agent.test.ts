import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATHS, fromRepoPath, loadAgentRegistry } from "@sre/config";
import { proposeAgentDeletion, removeGrant } from "@sre/runtime-host";
import { agentDocumentSchema } from "@sre/agent-schema";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

/**
 * Delete Agent: ONE pull request removing every file the Agent owns, and only
 * files that exist. Refused while another Agent still grants it cross-domain
 * access, because the catalog would refuse to load after that merge.
 */
const registry = loadAgentRegistry(CONFIG_PATHS);
const exists = (path: string) => existsSync(join(process.cwd(), fromRepoPath(path)));
const read = (path: string) => readFileSync(join(process.cwd(), fromRepoPath(path)), "utf8");

describe("proposeAgentDeletion", () => {
  it("removes the document, prompt and every environment's overlay and rendered values", () => {
    const agent = registry.getSpecialist("keycloak")!;
    const change = proposeAgentDeletion({ agent, requestedBy: "alice", environments: ["production", "poc", "local"], others: [], exists, read });
    expect(change.branch).toBe("agent/remove-keycloak");
    expect(change.files.every((file) => file.deleted === true && file.contents === "")).toBe(true);
    const paths = change.files.map((file) => file.path);
    expect(paths).toContain("platform/config/agents/keycloak.yaml");
    expect(paths).toContain("platform/config/prompts/keycloak.md");
    expect(paths).toContain("deploy/environments/production/agents/keycloak.yaml");
    expect(paths).toContain("deploy/environments/production/rendered/agents/keycloak.yaml");
    // only what is actually there: nothing is proposed for an environment that never had it
    expect(paths.every(exists)).toBe(true);
    expect(change.effects.some((effect) => effect.startsWith("Argo CD"))).toBe(true);
  });

  it("rewrites every other Agent that grants access to it, in the same change", () => {
    const agent = registry.getSpecialist("keycloak")!;
    const change = proposeAgentDeletion({ agent, requestedBy: "alice", environments: ["production"], others: registry.listSpecialists().filter((other) => other.name !== "keycloak"), exists, read });
    // observability.yaml really grants keycloak in this repository
    const rewritten = change.files.find((file) => file.path === "platform/config/agents/observability.yaml");
    expect(rewritten?.deleted).toBeUndefined();
    expect(rewritten?.contents).not.toMatch(/allowedNeedsDomains/u);
    // the OIDC provider is not the agent: identity stays exactly as it was
    expect(rewritten?.contents).toContain("identity: { provider: keycloak, clientId: sre-agent-observability }");
    expect(change.effects.some((effect) => effect.includes("observability no longer grants"))).toBe(true);
    // and the result still parses as a valid Agent document
    expect(() => agentDocumentSchema.parse(parseYaml(rewritten!.contents))).not.toThrow();
  });

  it("removeGrant drops one target and keeps the rest of the list", () => {
    const text = "spec:\n  discovery: { allowedNeedsDomains: [keycloak, openshift] }\n  security: { readOnly: true }\n";
    const out = removeGrant(text, "keycloak");
    expect(out).toContain("allowedNeedsDomains: [ openshift ]");
    expect(out).toContain("security: { readOnly: true }");
    expect(removeGrant(text, "nobody")).toBe(text);
  });
});
