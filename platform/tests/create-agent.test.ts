import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentDocumentSchema } from "@sre/agent-schema";
import { agentDeploymentOverlaySchema, buildAgentCatalog, CONFIG_PATHS, DEPLOY_ROOT, deployEnvironmentDir, loadAgentRegistry, loadDeploymentEnvironment } from "@sre/config";
import { generateAgentChange, proposeAgentChange, type AgentDraft } from "@sre/runtime-host";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

/**
 * Create Agent, end to end, against the representative fixture:
 *
 *   Backstage draft
 *        ↓
 *   ONE coherent change-set
 *        config/agents/network-security.yaml
 *        config/prompts/network-security.md
 *        deploy/environments/<env>/agents/network-security.yaml
 *        ↓
 *   the change is applied to a COPY of the repository's config, and the result
 *   is loaded by the same loader the runtime uses at startup
 *
 * The last step is the point. A change-set that merely looks right is not
 * evidence; one the real loader accepts, that produces a routable Agent, is.
 */

const draft: AgentDraft = {
  name: "network-security",
  owner: "network-security",
  displayName: "Network Security Agent",
  description: "Firewall policy, gateway state and security-zone reachability.",
  lifecycle: "active",
  modelTier: "small",
  modelProfile: "tool-caller",
  prompt: "You are the Network Security specialist. Investigate firewall policy and gateway state using only the approved read-only tools, and cite every claim.",
  environments: ["prod"],
  routing: { exactTerms: ["firewall policy", "security zone"], capabilities: ["firewall rules and gateway state"], exclusions: ["identity administration"] },
  requiredRoles: ["network-read"],
  crossDomainAllowed: ["network-observability"],
  access: [{ mcp: "wiki", tools: ["wiki_search", "wiki_read_page"] }],
};

describe("Create Agent", () => {
  it("produces exactly the three source files a deployable Agent needs", () => {
    const change = generateAgentChange(draft, "production");
    expect(change.files.map((file) => file.path)).toEqual([
      "config/agents/network-security.yaml",
      "config/prompts/network-security.md",
      "deploy/environments/production/agents/network-security.yaml",
    ]);
  });

  it("persists the prompt the operator typed", () => {
    const prompt = generateAgentChange(draft).files.find((file) => file.path.endsWith(".md"));
    expect(prompt?.contents).toContain("Investigate firewall policy and gateway state");
    expect(prompt?.contents.trim().length).toBeGreaterThan(0);
  });

  it("derives the workload client id and every audience rather than accepting them", () => {
    const document = agentDocumentSchema.parse(parseYaml(generateAgentChange(draft).yaml));
    if (document.spec.type !== "specialist") throw new Error("expected a specialist");
    expect(document.spec.identity.clientId).toBe("sre-agent-network-security");
    expect(document.spec.access.map((entry) => entry.audience)).toEqual(["sre-toolhive:wiki"]);
  });

  it("generates an overlay carrying deployment fields only", () => {
    const overlay = generateAgentChange(draft, "production").files.find((file) => file.path.startsWith("deploy/"));
    const parsed = agentDeploymentOverlaySchema.parse(parseYaml(overlay!.contents));
    expect(parsed).toMatchObject({ agentId: "network-security", enabled: true });
    expect(Object.keys(parsed)).not.toContain("routing");
    expect(Object.keys(parsed)).not.toContain("access");
  });

  it("emits no secret material anywhere in the change-set", () => {
    for (const file of generateAgentChange(draft).files) {
      expect(file.contents, file.path).not.toMatch(/client[_-]?secret|password|private[_-]?key|api[_-]?key|bearer /iu);
    }
  });

  /**
   * The whole point: applying the change to a copy of the real configuration
   * produces an Agent the runtime's own loader accepts and the Manager routes
   * to — with no second registry edited.
   */
  it("yields a routable Agent through the real loader, with no other logical source edited", () => {
    const change = generateAgentChange(draft, "production");
    const root = mkdtempSync(join(tmpdir(), "sre-create-agent-"));
    try {
      // the sandbox mirrors the real repository layout — platform/ beside deploy/ —
      // so the loader resolves exactly as it does in the working tree
      cpSync("config", join(root, "platform/config"), { recursive: true });
      cpSync(`${DEPLOY_ROOT}/environments`, join(root, "deploy/environments"), { recursive: true });
      for (const file of change.files) {
        const target = join(root, file.path.startsWith("deploy/") ? file.path : `platform/${file.path}`);
        mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
        writeFileSync(target, file.contents, "utf8");
      }
      // the manager must allow it before it can be routed to — that is the one
      // remaining human decision, and it lives with the Manager Agent
      const managerPath = join(root, "platform/config/agents/manager.yaml");
      writeFileSync(managerPath, readFileSync(managerPath, "utf8").replace("allowed: [", "allowed: [network-security, "), "utf8");

      const registry = loadAgentRegistry({ ...CONFIG_PATHS, baseDir: join(root, "platform") });
      expect(registry.getSpecialist("network-security")?.systemPrompt).toContain("Investigate firewall policy");

      const environment = loadDeploymentEnvironment(deployEnvironmentDir("production"), join(root, "platform"));
      const catalog = buildAgentCatalog(
        [registry.manager, ...registry.listSpecialists()].map((agent) => agentDocumentSchema.parse({
          apiVersion: "sre.ai/v1alpha1",
          kind: "Agent",
          metadata: { name: agent.name, owner: agent.owner, ...(agent.description ? { description: agent.description } : {}) },
          spec: agent.spec,
        })),
        environment.settings,
        environment.overlays,
      );
      const entry = catalog.resolve("network-security");
      expect(entry?.enabled).toBe(true);
      expect(entry?.endpoint).toBe("http://sre-agent-network-security.sre-assistant.svc.cluster.local");
      expect(catalog.listEnabled("prod").map((agent) => agent.agentId)).toContain("network-security");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("proposes the change as a pull request and never as a deployment", () => {
    const { change } = proposeAgentChange({ draft, requestedBy: "alice" });
    expect(change.files.map((file) => file.path)).toHaveLength(3);
    expect(change.branch).toBe("agent/add-network-security");
    expect(change.effects.some((effect) => /deploy now|apply|kubectl/iu.test(effect))).toBe(false);
    expect(change.effects.some((effect) => effect.includes("Argo CD: sync after merge"))).toBe(true);
  });

  it("refuses a draft whose prompt is missing, rather than generating a broken Agent", () => {
    const { prompt: _prompt, ...withoutPrompt } = draft;
    expect(() => generateAgentChange(withoutPrompt)).toThrow(/system prompt is required/u);
  });
});
