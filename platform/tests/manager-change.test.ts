import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATHS, loadAgentRegistry, toRepoPath } from "@sre/config";
import { generateManagerChange, managerDetail, managerDraftToDocument, proposeManagerChange, type ManagerDraft } from "@sre/runtime-host";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

/**
 * The Manager, edited through the console.
 *
 * It is a separate branch of the Agent document union — no workload identity,
 * no MCP access, no environments, no routing vocabulary, and an `agents.allowed`
 * routing table no specialist has. So it needs its own generator, and its own
 * proof that the console can rebuild what it displays.
 */

const registry = loadAgentRegistry(CONFIG_PATHS);
const detail = managerDetail(registry);

/** Exactly what a prefilled Manager editor can know, and nothing more. */
const draftFromDetail = (): ManagerDraft => ({
  allowed: detail.allowed,
  modelProfile: detail.modelProfile,
  prompt: detail.prompt,
  owner: detail.owner,
  ...(detail.displayName === undefined ? {} : { displayName: detail.displayName }),
  ...(detail.description === undefined ? {} : { description: detail.description }),
  lifecycle: detail.lifecycle as ManagerDraft["lifecycle"],
  promptFile: detail.promptFile,
  execution: { maxAgentsPerRequest: detail.execution.maxAgentsPerRequest as number, timeoutMs: detail.execution.timeoutMs as number },
});

describe("the Manager view describes the Manager, not a specialist", () => {
  it("serves the routing table and says why there is no workload identity", () => {
    expect(detail.id).toBe("manager");
    expect(detail.allowed).toEqual(registry.manager.spec.agents.allowed);
    expect(detail.identity.provider).toBe("none");
    // the Manager never calls a tool, so a blank client id would be a missing
    // fact rather than an absent one — the view states the reason instead
    expect(detail.identity.reason).toMatch(/no workload credential/u);
  });

  it("lists specialists that exist but are NOT routable, rather than omitting them", () => {
    const every = registry.listSpecialists().map(agent => agent.name).sort();
    expect([...detail.allowed, ...detail.notRouted].sort()).toEqual(every);
    // "not shown" and "not routable" must not look alike
    expect(detail.notRouted).toEqual([]);
  });

  it("exposes no tool access of any kind", () => {
    // the Manager receiving tool schemas would break the boundary the whole
    // design rests on, so the view must have nowhere to put them
    expect(Object.keys(detail)).not.toContain("access");
    expect(JSON.stringify(detail)).not.toMatch(/toolhive|audience/iu);
  });
});

describe("the Manager round-trips through a draft without losing anything", () => {
  it("regenerates config/agents/manager.yaml identically", () => {
    const regenerated = parseYaml(generateManagerChange(draftFromDetail()).yaml) as Record<string, unknown>;
    const onDisk = parseYaml(readFileSync(join(CONFIG_PATHS.agentsDir, "manager.yaml"), "utf8")) as Record<string, unknown>;
    expect(regenerated).toEqual(onDisk);
  });

  it("regenerates the prompt file the Manager actually loaded", () => {
    const files = generateManagerChange(draftFromDetail()).files;
    expect(files.map(file => file.path)).toEqual(["platform/config/agents/manager.yaml", toRepoPath(registry.manager.spec.prompt.systemFile)]);
    expect(files[1]?.contents).toContain(registry.manager.systemPrompt.trim());
  });

  it("touches two files, not the specialist's three: the deployment overlay is a separate decision", () => {
    expect(generateManagerChange(draftFromDetail()).files).toHaveLength(2);
    expect(generateManagerChange(draftFromDetail()).files.some(file => file.path.startsWith("deploy/"))).toBe(false);
  });
});

describe("the Manager document stays within its schema", () => {
  it("pins maxRounds to 1, which no draft can raise", () => {
    const document = managerDraftToDocument({ ...draftFromDetail(), execution: { maxAgentsPerRequest: 3, timeoutMs: 1_500 } });
    expect(document.spec.type === "manager" && document.spec.execution.maxRounds).toBe(1);
    // a second Manager loop is a runtime feature, never configuration (TDD §5.1),
    // so the draft has no field for it and the schema pins the literal
    expect(Object.keys(draftFromDetail().execution ?? {})).not.toContain("maxRounds");
  });

  /**
   * The renderer omits `lifecycle` when it is the default, so that editing the
   * Manager does not add a line the checked-in file never had. Omitting it
   * unconditionally would have made disabling the Manager a no-op that still
   * reported success — the same silent-drop class the specialist round-trip
   * test exists to catch.
   */
  it("writes a non-default lifecycle instead of silently dropping it", () => {
    const yaml = generateManagerChange({ ...draftFromDetail(), lifecycle: "disabled" }).yaml;
    expect(parseYaml(yaml).spec.lifecycle).toBe("disabled");
    // and still omits it at the default, so an ordinary edit is a clean diff
    expect(generateManagerChange(draftFromDetail()).yaml).not.toContain("lifecycle:");
  });

  it("rejects a routing entry that is not a known agent name", () => {
    expect(() => managerDraftToDocument({ ...draftFromDetail(), allowed: ["Not A Name"] })).toThrow(/invalid agent draft/u);
  });

  it("rejects an empty routing table: a Manager that can route nowhere is not a Manager", () => {
    expect(() => managerDraftToDocument({ ...draftFromDetail(), allowed: [] })).toThrow(/invalid agent draft/u);
  });

  it("rejects an empty prompt rather than generating a file the runtime refuses", () => {
    expect(() => generateManagerChange({ ...draftFromDetail(), prompt: "   " })).toThrow(/system prompt is required/u);
  });

  it("refuses more agents per request than the schema allows", () => {
    expect(() => managerDraftToDocument({ ...draftFromDetail(), execution: { maxAgentsPerRequest: 9, timeoutMs: 1_500 } })).toThrow(/invalid agent draft/u);
  });
});

describe("a proposed Manager change names what moved", () => {
  it("reports an agent losing routability by name, not as a count", () => {
    const draft = { ...draftFromDetail(), allowed: detail.allowed.filter(name => name !== "openshift") };
    const { change } = proposeManagerChange({ draft, current: registry.manager, requestedBy: "tester" });
    expect(change.effects).toContain("Routing: openshift stops being reachable through the Manager");
    expect(change.branch).toBe("agent/update-manager");
    expect(change.body).toContain("~~`openshift`~~ **(removed)**");
  });

  it("reports an agent gaining routability by name", () => {
    // dropping then re-adding is the only way to observe an addition against a
    // registry where every specialist is already routed
    const reduced = { ...registry.manager, spec: { ...registry.manager.spec, agents: { allowed: detail.allowed.filter(name => name !== "keycloak") } } };
    const { change } = proposeManagerChange({ draft: draftFromDetail(), current: reduced, requestedBy: "tester" });
    expect(change.effects).toContain("Routing: keycloak becomes reachable through the Manager");
  });

  it("states that no tool access is granted, because the Manager holds none", () => {
    const { change } = proposeManagerChange({ draft: draftFromDetail(), current: registry.manager, requestedBy: "tester" });
    expect(change.body).toContain("grants no tool access");
    expect(change.effects.every(effect => !/toolhive|keycloak client|scope/iu.test(effect))).toBe(true);
  });

  it("records the requester for audit without inventing an identity", () => {
    const { change } = proposeManagerChange({ draft: draftFromDetail(), current: registry.manager, requestedBy: "alice@example.com" });
    expect(change.body).toContain("Requested by: alice@example.com");
  });
});
