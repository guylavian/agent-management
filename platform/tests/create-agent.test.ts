import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentDocumentSchema } from "@sre/agent-schema";
import { agentDeploymentOverlaySchema, buildAgentCatalog, CONFIG_PATHS, DEPLOY_ROOT, deployEnvironmentDir, loadAgentRegistry, loadDeploymentEnvironment, toRepoPath } from "@sre/config";
import { agentDetail, AgentDraftError, generateAgentChange, proposeAgentChange, proposePromptChange, type AgentDraft } from "@sre/runtime-host";
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
  routing: { capabilities: ["firewall rules and gateway state"], exclusions: ["identity administration"] },
  requiredRoles: ["network-read"],
  crossDomainAllowed: ["network-observability"],
  access: [{ mcp: "wiki", tools: ["wiki_search", "wiki_read_page"] }],
};

describe("Create Agent", () => {
  /**
   * The rendered values are the fourth file, and the one Argo actually reads:
   * its ApplicationSet globs `rendered/`, so a change-set without it adds an
   * Agent to Git that never deploys and reports no error anywhere.
   */
  it("produces every file a deployable Agent needs, including the render Argo globs", () => {
    const change = generateAgentChange(draft, "production");
    const paths = change.files.map((file) => file.path);
    expect(paths).toEqual(expect.arrayContaining([
      "platform/config/agents/network-security.yaml",
      "platform/config/prompts/network-security.md",
      "deploy/environments/production/agents/network-security.yaml",
      "deploy/environments/production/rendered/agents/network-security.yaml",
    ]));
    /*
     * And the Manager's bundle for EVERY environment. That bundle carries the
     * canonical registry — every Agent that exists, deployed here or not — so
     * adding one changes it everywhere. A change-set that left it alone merged
     * cleanly and then failed the repository's own check:generated gate, while
     * a production Manager reading these mounts never learned the Agent existed.
     */
    expect(paths).toEqual(expect.arrayContaining([
      "deploy/environments/production/rendered/agents/manager.yaml",
      "deploy/environments/local/rendered/agents/manager.yaml",
    ]));

    const rendered = change.files.find((file) => file.path.endsWith("rendered/agents/network-security.yaml"))?.contents ?? "";
    expect(rendered).toContain("name: network-security");
    expect(rendered).toContain("deploymentEnvironment: production");
    // the digest is what makes a later prompt edit a visible, syncable diff
    expect(rendered).toMatch(/promptSha256: [a-f0-9]{64}/u);
  });

  /**
   * A change-set is committed to the REPOSITORY, and the runtime does not run
   * at its root: what the runtime calls `config/agents/x.yaml` is
   * `platform/config/agents/x.yaml` in Git.
   *
   * This was wrong, and the failure mode was quiet — a pull request would have
   * created new files at the repository root, left the real ones untouched, and
   * reported success. Every file in every change-set is checked against what
   * Git actually tracks.
   */
  it("names every file the way the repository addresses it, not the way the runtime does", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: `${process.cwd()}/..`, encoding: "utf8" }).split("\n");
    for (const file of generateAgentChange({ ...draft, name: "active-directory" }, "production").files) {
      expect(file.path).not.toMatch(/^config\//u);
      // the sibling of an existing tracked file must itself be tracked, or the
      // change-set is writing somewhere the repository does not keep this kind
      const directory = file.path.slice(0, file.path.lastIndexOf("/"));
      expect(tracked.some(entry => entry.startsWith(`${directory}/`)), `${directory} is not a directory this repository tracks`).toBe(true);
    }
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

  it("emits no secret material in the files it authors", () => {
    /*
     * Scoped to what this change WRITES. The Manager's bundle also travels in
     * the change-set, but it is a projection of files already committed —
     * model-bindings.yaml, environment.yaml, other Agents' documents — and
     * scanning them here protects nothing new while failing on a comment that
     * merely names a variable (SRE_LLM_API_KEY in poc's bindings). Those files
     * are covered where it counts: `validate:tracked` refuses to let credential
     * material become tracked at all, and runs in `npm run check`.
     */
    const authored = generateAgentChange(draft).files.filter((file) => !file.path.endsWith("rendered/agents/manager.yaml"));
    expect(authored.length).toBeGreaterThan(0);
    for (const file of authored) {
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
        // change-set paths are already repository-relative, so the sandbox
        // takes them verbatim; it used to prefix platform/ itself, compensating
        // for a generator that emitted runtime-relative paths
        const target = join(root, file.path);
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
    // four authored files, plus the Manager's bundle for each environment
    const authored = change.files.filter((file) => !file.path.endsWith("rendered/agents/manager.yaml"));
    expect(authored.map((file) => file.path)).toHaveLength(4);
    expect(change.branch).toBe("agent/add-network-security");
    // nothing here reaches a cluster: the portal writes Git and Argo does the rest
    expect(change.effects.some((effect) => /deploy now|apply|kubectl/iu.test(effect))).toBe(false);
    expect(change.effects.some((effect) => /Argo CD:/u.test(effect))).toBe(true);
  });

  /**
   * A REVIEWER MUST BE TOLD WHEN MERGING DEPLOYS NOTHING.
   *
   * The effect used to read "Argo CD: sync after merge" unconditionally. For a
   * draft that is false: the overlay is written with `enabled: false`, the
   * renderer emits no Application, and Argo does nothing at all. Someone
   * approved a change whose stated effect was a deployment, watched for it, and
   * had nothing anywhere to explain the silence.
   */
  it("says plainly that a draft deploys nothing, and names the environment when it does", () => {
    const asDraft = proposeAgentChange({ draft: { ...draft, lifecycle: "draft" }, requestedBy: "alice", targetEnvironment: "local" }).change;
    expect(asDraft.effects.some((effect) => /NOTHING is deployed/u.test(effect))).toBe(true);
    expect(asDraft.effects.some((effect) => effect.includes("enabled: false"))).toBe(true);

    const asActive = proposeAgentChange({ draft: { ...draft, lifecycle: "active" }, requestedBy: "alice", targetEnvironment: "local" }).change;
    expect(asActive.effects.some((effect) => /deploys network-security to local after merge/u.test(effect))).toBe(true);
    expect(asActive.effects.some((effect) => /NOTHING is deployed/u.test(effect))).toBe(false);
  });

  /**
   * THE CHANGE-SET MUST LAND IN THE ENVIRONMENT THIS RUNTIME SERVES.
   *
   * The target defaulted to the literal "production", so a runtime serving
   * `local` wrote its overlay and rendered values into
   * `deploy/environments/production/`. Nothing in that cluster globs it: the
   * pull request merged, the portal reported it merged, and Argo never saw an
   * Application because the files were in an environment nobody deploys.
   */
  /**
   * TWO IMPLEMENTATIONS OF "WHICH AGENTS GET RENDERED" MUST NOT DISAGREE.
   *
   * `tools/render-agent-deployment` skips every disabled overlay, so it emits
   * no rendered values for a draft. This generator used to emit them anyway,
   * which put a file in the change-set that the canonical renderer deletes on
   * its next run: a merged pull request left `main` failing its own
   * `check:generated` gate. The invisible half was worse — had the file
   * survived, Argo's ApplicationSet globs `rendered/`, so it would have
   * deployed an Agent whose own document says it is a draft.
   */
  it("renders Helm values for an active Agent and none at all for a draft", () => {
    const active = proposeAgentChange({ draft: { ...draft, lifecycle: "active" }, requestedBy: "alice", targetEnvironment: "local" }).change.files.map((file) => file.path);
    expect(active).toContain("deploy/environments/local/rendered/agents/network-security.yaml");

    const asDraft = proposeAgentChange({ draft: { ...draft, lifecycle: "draft" }, requestedBy: "alice", targetEnvironment: "local" }).change.files.map((file) => file.path);
    /*
     * A draft renders no values of its OWN — absence is how "do not deploy this"
     * reaches the ApplicationSet. But it IS in the canonical registry, so the
     * Manager's bundle still moves: that is precisely what a real merge got
     * wrong, leaving `main` failing its own check:generated gate after a draft
     * Agent was added through the console.
     */
    expect(asDraft.some((path) => /rendered\/agents\/(?!manager\.yaml)/u.test(path))).toBe(false);
    expect(asDraft.some((path) => path.endsWith("rendered/agents/manager.yaml"))).toBe(true);
    // the document, the prompt and the overlay still travel: a draft is merged
    // and visible, it is only not deployed
    expect(asDraft).toContain("deploy/environments/local/agents/network-security.yaml");
    expect(asDraft.filter((path) => !path.endsWith("rendered/agents/manager.yaml"))).toHaveLength(3);
  });

  it("writes the overlay and the render into the target environment, not a hardcoded one", () => {
    const paths = proposeAgentChange({ draft, requestedBy: "alice", targetEnvironment: "local" }).change.files.map((file) => file.path);
    expect(paths).toContain("deploy/environments/local/agents/network-security.yaml");
    expect(paths).toContain("deploy/environments/local/rendered/agents/network-security.yaml");
    // the AGENT's files stay in the target environment; the Manager's bundle
    // spans every environment by design, because the registry it carries is global
    const agentFiles = paths.filter((path) => !path.endsWith("rendered/agents/manager.yaml"));
    expect(agentFiles.every((path) => !path.includes("environments/production"))).toBe(true);
  });

  /**
   * A real incident: an agent created in the console declared a cross-domain
   * grant to an agent that did not exist. The draft passed schema validation,
   * the pull request merged, and StaticAgentCatalog then refused the edge at
   * STARTUP — so every environment stopped loading its configuration at all.
   *
   * The check belongs where the draft is written, not where it is loaded.
   */
  it("refuses a cross-domain grant to an agent that does not exist", () => {
    const dangling = { ...draft, crossDomainAllowed: ["no-such-agent"] };
    expect(() => proposeAgentChange({ draft: dangling, requestedBy: "alice", knownAgents: ["observability"] }))
      .toThrow(/is not an agent that exists/u);
  });

  it("accepts a cross-domain grant to an agent that does exist", () => {
    const granted = { ...draft, crossDomainAllowed: ["observability"] };
    expect(() => proposeAgentChange({ draft: granted, requestedBy: "alice", knownAgents: ["observability"] })).not.toThrow();
  });

  // a self-edge was already refused, by the document schema rather than here
  it("refuses a cross-domain grant an agent gives itself", () => {
    const selfEdge = { ...draft, crossDomainAllowed: [draft.name] };
    expect(() => proposeAgentChange({ draft: selfEdge, requestedBy: "alice", knownAgents: ["observability"] }))
      .toThrow(/cannot discover itself/u);
  });

  it("refuses a draft whose prompt is missing, rather than generating a broken Agent", () => {
    const { prompt: _prompt, ...withoutPrompt } = draft;
    expect(() => generateAgentChange(withoutPrompt)).toThrow(/system prompt is required/u);
  });
});

/**
 * Editing a prompt must NOT go through AgentDraft.
 *
 * AgentDetailView carries no routing and no capabilities, so rebuilding a draft
 * from what the portal holds and re-rendering the Agent document would silently
 * drop them. The prompt is its own file, so the change-set touches that file and
 * nothing else — which is what these assertions pin.
 */
describe("Propose a prompt change", () => {
  const agent = loadAgentRegistry(CONFIG_PATHS).getSpecialist("active-directory")!;

  it("touches only the prompt file and leaves the Agent document alone", () => {
    const change = proposePromptChange({ agent, prompt: "New investigative guidance.", requestedBy: "alice" });
    expect(change.files).toHaveLength(1);
    // the document keeps a RUNTIME-relative reference, because that is what the
    // runtime resolves; the change-set names the same file as the REPOSITORY
    // addresses it, because that is what gets committed
    expect(change.files[0]?.path).toBe(toRepoPath(agent.spec.prompt.systemFile));
    expect(change.files[0]?.path).toMatch(/^platform\/config\/prompts\//u);
    expect(change.files.some((file) => file.path.startsWith("platform/config/agents/"))).toBe(false);
    expect(change.files.some((file) => file.path.startsWith("deploy/"))).toBe(false);
  });

  it("writes the operator's text verbatim under a heading", () => {
    const change = proposePromptChange({ agent, prompt: "  Check replication first.  ", requestedBy: "alice" });
    expect(change.files[0]?.contents).toBe(`# ${agent.displayName ?? agent.name}\n\nCheck replication first.\n`);
  });

  it("records the requester and names the single changed file in the pull-request body", () => {
    const change = proposePromptChange({ agent, prompt: "x", requestedBy: "carol" });
    expect(change.body).toContain("carol");
    expect(change.body).toContain(agent.spec.prompt.systemFile);
    expect(change.effects).toEqual(expect.arrayContaining([`update ${toRepoPath(agent.spec.prompt.systemFile)}`]));
  });

  it("refuses an empty prompt rather than generating a file the runtime would reject", () => {
    expect(() => proposePromptChange({ agent, prompt: "   ", requestedBy: "alice" })).toThrow(/prompt/u);
  });
});

/**
 * THE ROUND TRIP that makes editing an Agent safe.
 *
 * Editing re-renders the WHOLE Agent document from an AgentDraft, so any field
 * the console cannot see is a field an edit would silently delete — and a diff
 * that quietly drops routing is one a reviewer would probably approve. This
 * asserts that a draft rebuilt from what the portal actually holds regenerates
 * the document it started from, for every agent in the real catalog.
 */
describe("Agent detail round-trips through a draft without losing anything", () => {
  const registry = loadAgentRegistry(CONFIG_PATHS);

  /** Exactly what a prefilled Create Agent wizard can know, and nothing more. */
  const draftFromDetail = (detail: ReturnType<typeof agentDetail>, prompt: string): AgentDraft => ({
    name: detail.id,
    owner: detail.owner,
    displayName: detail.displayName,
    ...(detail.description === undefined ? {} : { description: detail.description }),
    lifecycle: detail.lifecycle,
    modelTier: detail.modelTier as "small" | "large",
    modelProfile: detail.modelProfile,
    promptFile: detail.promptFile,
    prompt,
    environments: detail.environments,
    routing: detail.routing,
    requiredRoles: detail.requiredRoles,
    crossDomainAllowed: detail.crossDomainAllowed,
    access: detail.access.filter(entry => entry.allowed).map(entry => ({ mcp: entry.mcp, tools: entry.allowedTools.map(tool => tool.name) })),
    limits: detail.limits,
  });

  for (const agent of registry.listSpecialists()) {
    it(`regenerates ${agent.name} identically`, () => {
      const detail = agentDetail(agent, registry.catalog);
      const regenerated = parseYaml(generateAgentChange(draftFromDetail(detail, detail.prompt)).yaml) as { spec: Record<string, unknown> };

      // routing and capabilities are the fields a lossy view would drop
      expect(regenerated.spec.routing).toEqual(agent.spec.routing);
      expect(regenerated.spec.environments).toEqual(agent.spec.environments);
      expect(regenerated.spec.access).toEqual(agent.spec.access);
      expect(regenerated.spec.execution).toEqual(agent.spec.execution);
      expect(regenerated.spec.authorization).toEqual(agent.spec.authorization);
      expect(regenerated.spec.identity).toEqual(agent.spec.identity);
      expect(regenerated.spec.lifecycle).toEqual(agent.spec.lifecycle);
      expect(regenerated.spec.model).toEqual(agent.spec.model);
      expect(regenerated.spec.prompt).toEqual(agent.spec.prompt);
    });

    /**
     * The one loss the round-trip test above cannot catch by construction: the
     * detail view is built by intersecting the Agent's grants with the approved
     * catalog, so a granted tool absent from the catalog appears in NEITHER
     * `allowedTools` nor `blockedTools` and would be silently dropped by an edit.
     *
     * That grant is already dead at runtime — `authorizeTool` denies it — so the
     * fix is to notice it here rather than to let the portal quietly delete it.
     */
    /**
     * The wizard sends the same draft whether it is creating or editing; the
     * runtime decides which by looking the Agent up. A change that says "Add"
     * while editing would open a pull request whose title contradicts its diff.
     */
    it(`proposes ${agent.name} as an update, not an addition`, () => {
      const detail = agentDetail(agent, registry.catalog);
      const { change } = proposeAgentChange({ draft: draftFromDetail(detail, detail.prompt), requestedBy: "tester", update: true });
      expect(change.branch).toBe(`agent/update-${agent.name}`);
      expect(change.title).toMatch(/^Update/u);
      expect(change.effects.every(effect => !effect.startsWith("create "))).toBe(true);
    });

    it(`grants ${agent.name} only tools the approved catalog knows`, () => {
      const known = new Set(registry.catalog.tools.map(tool => `${tool.serverId}/${tool.toolName}`));
      const unknown = agent.spec.access.flatMap(entry => entry.tools.filter(tool => !known.has(`${entry.mcp}/${tool}`)).map(tool => `${entry.mcp}/${tool}`));
      expect(unknown).toEqual([]);
    });
  }
});

/**
 * A MALFORMED DRAFT IS NOT A GITOPS OUTAGE.
 *
 * /management/agents/preview caught every error and reported
 * `GITOPS_UNAVAILABLE — The change could not be proposed`. That route performs
 * NO network I/O: it renders YAML and diffs it against disk. GitOps cannot be
 * the cause of a failure there, so the message sent an operator to check GitHub,
 * their token and their network for what was actually an invalid form.
 *
 * Observed in the portal: an incomplete draft produced GITOPS_UNAVAILABLE while
 * the GitHub token was valid, with `repo` scope and push permission on the
 * target repository.
 *
 * Worse, the draft was never validated: an empty object reached
 * `.map()` on an undefined field and threw a raw TypeError.
 */
describe("a bad draft is reported as a bad draft", () => {
  it("rejects an empty draft with issues, not a TypeError", () => {
    let thrown: unknown;
    try { proposeAgentChange({ draft: {} as never, requestedBy: "tester", targetEnvironment: "local" }); }
    catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AgentDraftError);
    // an operator has to be able to see WHICH field is wrong
    expect((thrown as AgentDraftError).issues.length).toBeGreaterThan(0);
  });

  it("names the missing fields rather than failing on the first undefined", () => {
    let thrown: unknown;
    try { proposeAgentChange({ draft: { name: "probe" } as never, requestedBy: "tester", targetEnvironment: "local" }); }
    catch (error) { thrown = error; }
    const issues = (thrown as AgentDraftError).issues.join(" ");
    expect(issues).toMatch(/access|displayName|description|identity/iu);
  });
});

/**
 * AN AGENT PROPOSED IN THE CONSOLE MUST ARRIVE IN GIT ALREADY RENDERED.
 *
 * Observed with a real merge: the portal opened a pull request adding the Agent
 * document, its prompt and its deployment overlay. It merged cleanly, the
 * console showed it merged, git-sync delivered it, and the Manager listed the
 * Agent as a draft. No workload was ever created, because the ApplicationSet
 * globs `deploy/environments/<env>/rendered/agents/*.yaml` and the change
 * produced no such file. `npm run render:deploy` makes them, and nothing runs
 * it — there is no CI in this repository — so the artifact Argo consumes was
 * generated only on a laptop.
 *
 * The renderer already says this is the intent: renderAgentValues lives in
 * @sre/config "so the management plane renders a DRAFT with the same code — an
 * Agent proposed in the console must arrive in Git already rendered, or Argo,
 * which globs rendered/, never sees it".
 *
 * The Manager's OWN rendered file must move too. It carries the whole estate's
 * desired state as ConfigMaps, so a production Manager — which reads those
 * mounts rather than a git checkout — would otherwise never learn the Agent
 * exists. This cluster hid that, because gitSync lets it read the checkout.
 */
describe("a proposed Agent arrives deployable", () => {
  const files = () => proposeAgentChange({ draft, requestedBy: "alice", targetEnvironment: "local" }).change.files.map((f) => f.path);

  it("renders the values the ApplicationSet globs", () => {
    expect(files()).toContain("deploy/environments/local/rendered/agents/network-security.yaml");
  });

  it("updates the Manager's bundle, or a production Manager never sees the Agent", () => {
    expect(files()).toContain("deploy/environments/local/rendered/agents/manager.yaml");
  });

  it("carries the new Agent inside the Manager's desired state", () => {
    const change = proposeAgentChange({ draft, requestedBy: "alice", targetEnvironment: "local" }).change;
    const manager = change.files.find((f) => f.path.endsWith("rendered/agents/manager.yaml"));
    expect(manager?.contents).toContain("network-security.yaml");
  });

  it("renders the AGENT into the environment the change targets, not a default", () => {
    // the earlier defect: overlay and values written to production while the
    // runtime served local, so the pull request merged and Argo saw nothing.
    // The Manager's bundle is different and DOES span every environment,
    // because the canonical registry it carries is global.
    const files = proposeAgentChange({ draft, requestedBy: "alice", targetEnvironment: "poc" }).change.files;
    const agentRenders = files.filter((f) => /rendered\/agents\/(?!manager\.yaml)/u.test(f.path));
    expect(agentRenders.map((f) => f.path)).toEqual(["deploy/environments/poc/rendered/agents/network-security.yaml"]);
  });
});
