import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Router, type Request, type Response } from "express";
import { fromRepoPath, type AgentCatalog, type AgentDeploymentOverlay, type AgentLifecycle, type AgentRegistry, type AppConfig } from "@sre/config";
import type { ModelClient } from "@sre/llm";
import { BUILT_IN_ICONS, CONTENT_TYPE, AvatarError, isManagedAvatarPath, validateAvatar } from "./avatar.ts";
import { diffFile, summarise, type ChangeSetDiff } from "./diff.ts";
import { proposeManagerChange, type ManagerDraft } from "./manager-yaml.ts";
import { draftSystemPrompt, PromptAssistError, safeContext } from "./prompt-assist.ts";
import {
  reconcile,
  unobserved,
  type AgentReconciliation,
  type DeploymentStatusSource,
  type RuntimeProbe,
  type Signal,
} from "./reconciliation.ts";
import { diagnoseRun, RunDiagnosisError } from "./run-diagnosis.ts";
import { RunHistoryUnavailableError } from "./run-store.ts";
import type { RunStore } from "./run-store.ts";
import { agentDetail, agentSummary, managerDetail, mcpServerViews, permissionMatrix } from "./view-model.ts";
import { AgentDraftError, proposeAgentChange, proposeAgentDeletion, proposePromptChange, type AgentDraft } from "./yaml.ts";

/**
 * Read-only management API (TDD §43). Mounted only on the Manager, which is the
 * process that holds the full agent registry.
 *
 * It is a projection of configuration and bounded run metadata. It never
 * exposes tokens, secrets, credentials, model reasoning or unredacted tool
 * output, and it performs no mutation: an Agent changes by merging a pull
 * request, not by calling this API.
 */
/**
 * One snapshot of GIT DESIRED STATE, plus what this environment deploys.
 *
 * Structural on purpose: the composition root supplies a re-reading source, and
 * tests supply a literal. Either way the management API and the Manager's
 * router read the SAME object, so the console can never list a set of agents
 * the router does not have.
 */
export interface ManagementState {
  /** the canonical set: every Agent that exists, deployed here or not */
  registry: AgentRegistry;
  /**
   * The EFFECTIVE catalog: canonical ∩ deployment overlays ∩ observed
   * availability. It must be the same object the orchestrator routes from —
   * the console asking it directly is what makes "Routable" mean the same
   * thing on both sides.
   */
  catalog: AgentCatalog;
  environment: string;
  enabledAgentIds: string[];
  overlays: ReadonlyMap<string, AgentDeploymentOverlay>;
  revision: string;
  loadedAt: string;
  /** the most recent reload failed to validate; the snapshot is the last good one */
  error?: string;
}

export interface ManagementDeps {
  /**
   * Called PER REQUEST, not captured once.
   *
   * The registry used to be loaded at startup and held for the life of the
   * process, so a merged pull request was invisible until someone restarted the
   * Manager. Every read below goes through this, which is what makes "merge is
   * enough" true.
   */
  state: () => ManagementState;
  config: AppConfig;
  runs: RunStore;
  /**
   * Backs console assistance only, on the platform `prompt-assist` profile.
   * Optional: a deployment that does not want a drafting aid simply omits it,
   * and the endpoint reports that rather than falling back to an Agent's model.
   */
  promptAssistModel?: ModelClient;
  /**
   * ACTUAL state. Both optional, and both report `unknown` when absent rather
   * than defaulting to a colour — see reconciliation.ts on why an invented
   * green is worse than an honest question mark.
   */
  argo?: DeploymentStatusSource;
  runtimeProbe?: RuntimeProbe;
}

const NO_ARGO = "no Argo CD API is configured for this deployment";
const NO_PROBE = "no runtime health probe is configured for this deployment";

export function managementRouter(deps: ManagementDeps): Router {
  const router = Router();
  const specialists = () => deps.state().registry.listSpecialists();

  /**
   * Actual state for one Agent, or an honest `unknown`.
   *
   * An Agent this environment has no overlay for is not probed at all: a pod
   * that was never meant to exist is not "unreachable", and a red dot on it
   * would be noise on every environment that runs a subset of the catalog.
   *
   * An Agent whose overlay says `enabled: false` IS still probed, which is not
   * an oversight. Turning an Agent off is a reconciliation, not an instant, and
   * the only way to tell "being pruned" from "gone" is to keep asking until
   * Argo says the Application is Missing. Skipping the probe here made every
   * disable report DISABLED the moment the file changed, while the pod was
   * still serving traffic.
   */
  const observe = async (agentId: string, observable: boolean, endpoint?: string): Promise<{ argo: Signal; runtime: Signal }> => {
    if (!observable) {
      const detail = "this environment has no deployment overlay for this Agent, so nothing was probed";
      return { argo: unobserved(detail), runtime: unobserved(detail) };
    }
    const [argo, runtime] = await Promise.allSettled([
      deps.argo === undefined ? Promise.resolve(unobserved(NO_ARGO)) : deps.argo.status(agentId),
      deps.runtimeProbe === undefined || endpoint === undefined
        ? Promise.resolve(unobserved(NO_PROBE))
        : deps.runtimeProbe.status(agentId, endpoint),
    ]);
    return {
      // a source that THREW told us nothing; it must not read as a failure of
      // the agent it was asked about
      argo: argo.status === "fulfilled" ? argo.value : unobserved("the Argo CD status source failed"),
      runtime: runtime.status === "fulfilled" ? runtime.value : unobserved("the runtime probe failed"),
    };
  };

  const reconciliationFor = async (state: ManagementState, agentId: string, lifecycle: AgentLifecycle): Promise<AgentReconciliation> => {
    const overlay = state.overlays.get(agentId);
    const entry = state.catalog.resolve(agentId);
    // a draft is not deployed by anyone yet, so there is nothing to ask about
    const { argo, runtime } = await observe(agentId, lifecycle !== "draft" && overlay !== undefined, entry?.endpoint);
    return reconcile({
      agentId,
      lifecycle,
      /*
       * ASKED, not derived. `state.catalog` is the effective catalog the
       * orchestrator routes from — desired state intersected with observed
       * availability — so this is the router's own answer rather than a second
       * calculation that could drift away from it.
       */
      routable: state.catalog.listEnabled().some((candidate) => candidate.agentId === agentId),
      environment: state.environment,
      ...(overlay === undefined ? {} : { overlay }),
      ...(state.error === undefined ? {} : { loadError: state.error }),
      argo,
      runtime,
    });
  };

  /**
   * The Agents directory: GIT DESIRED STATE joined to actual state.
   *
   * It lists the canonical registry, NOT the runtime's enabled set. That is the
   * whole point — an Agent that merged and then failed to deploy has to stay on
   * this page with a reason, and listing from what is running is exactly how it
   * used to disappear at the moment someone needed to find it.
   */
  router.get("/agents", async (_request: Request, response: Response) => {
    const state = deps.state();
    const agents = state.registry.listSpecialists();
    const settled = await Promise.allSettled(
      agents.map((agent) => reconciliationFor(state, agent.name, agent.spec.lifecycle)),
    );
    response.json({
      revision: state.revision,
      loadedAt: state.loadedAt,
      ...(state.error === undefined ? {} : { configError: state.error }),
      agents: agents.map((agent, index) => {
        const outcome = settled[index];
        return {
          ...agentSummary(agent),
          ...(outcome?.status === "fulfilled" ? { reconciliation: outcome.value } : {}),
        };
      }),
    });
  });

  router.get("/agents/:id", async (request: Request, response: Response) => {
    const state = deps.state();
    const agent = state.registry.getSpecialist(request.params.id as string);
    if (agent === undefined) { notFound(response, "agent"); return; }
    response.json({
      ...agentDetail(agent, state.registry.catalog),
      reconciliation: await reconciliationFor(state, agent.name, agent.spec.lifecycle),
    });
  });

  /**
   * Configured posture, not a live probe. Reporting "healthy" here without
   * having asked the Agent would be fabricated telemetry, so reachability is
   * explicitly reported as unknown until a probe exists.
   */
  router.get("/agents/:id/health", async (request: Request, response: Response) => {
    const state = deps.state();
    const agent = state.registry.getSpecialist(request.params.id as string);
    if (agent === undefined) { notFound(response, "agent"); return; }
    const reconciliation = await reconciliationFor(state, agent.name, agent.spec.lifecycle);
    response.json({
      agentId: agent.name,
      lifecycle: agent.spec.lifecycle,
      // the effective catalog, which is the set the orchestrator routes from —
      // not a hand-written list that could disagree with it
      routable: reconciliation.manager.state === "ok",
      reachability: reconciliation.runtime.state === "ok" ? "ready" : reconciliation.runtime.state === "degraded" ? "unavailable" : "unknown",
      reason: reconciliation.runtime.detail,
      reconciliation,
    });
  });

  router.get("/agents/:id/metrics", async (request: Request, response: Response) => {
    const agent = deps.state().registry.getSpecialist(request.params.id as string);
    if (agent === undefined) { notFound(response, "agent"); return; }
    const allRuns = await deps.runs.list(200);
    const runs = allRuns.filter((run) => run.agents.includes(agent.name));
    if (runs.length === 0) {
      response.json({ agentId: agent.name, status: "not-configured", reason: "no runs recorded in this process" });
      return;
    }
    const durations = runs.map((run) => run.durationMs).sort((left, right) => left - right);
    response.json({
      agentId: agent.name,
      source: "in-process run history (not durable)",
      requestCount: runs.length,
      successRate: runs.filter((run) => run.status === "complete").length / runs.length,
      p95LatencyMs: durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))],
      lastActivity: runs[0]?.startedAt,
    });
  });

  router.get("/mcp-servers", (_request: Request, response: Response) => {
    response.json({ servers: mcpServerViews(specialists(), deps.state().registry.catalog, deps.config.toolhive.endpoints) });
  });

  router.get("/permissions", (_request: Request, response: Response) => {
    response.json(permissionMatrix(specialists(), deps.state().registry.catalog));
  });

  router.get("/runs", async (request: Request, response: Response) => {
    const limit = Number.parseInt(String(request.query.limit ?? "50"), 10);
    const runs = await deps.runs.list(Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50);
    response.json({ runs });
  });

  router.get("/runs/:id", async (request: Request, response: Response) => {
    let run;
    try {
      run = await deps.runs.get(request.params.id as string);
    } catch (error) {
      // A history that cannot be read is not an empty history. 404 here would
      // tell an operator mid-incident that the run never happened.
      if (error instanceof RunHistoryUnavailableError) {
        response.status(503).set("Retry-After", "5").json({ code: "DEPENDENCY_UNAVAILABLE", message: "Run history is temporarily unavailable", retryable: true });
        return;
      }
      throw error;
    }
    if (run === undefined) { notFound(response, "run"); return; }
    response.json(run);
  });

  /**
   * Read one run's trace with the console-assistance model.
   *
   * PURE: it stores nothing, and in particular writes nothing back onto the run
   * record. A run trace holds facts; keeping a model's reading beside them
   * would blur which is which the first time someone cites one.
   *
   * What leaves the process is the trace the console already renders — see
   * run-diagnosis.ts on why that is the allowlist rather than a copy of it.
   */
  router.post("/runs/:id/diagnose", async (request: Request, response: Response) => {
    const run = await deps.runs.get(request.params.id as string);
    if (run === undefined) { notFound(response, "run"); return; }
    if (deps.promptAssistModel === undefined) {
      response.status(501).json({ code: "NOT_CONFIGURED", message: "No console-assistance model profile is configured for this environment" });
      return;
    }
    try {
      response.json({ diagnosis: await diagnoseRun(deps.promptAssistModel, run) });
    } catch (error) {
      if (error instanceof RunDiagnosisError) {
        response.status(502).json({ code: "RUN_DIAGNOSIS_UNAVAILABLE", message: "The run could not be diagnosed" });
        return;
      }
      // never echo a provider error body: it can disclose endpoints or policy
      response.status(502).json({ code: "RUN_DIAGNOSIS_UNAVAILABLE", message: "The run could not be diagnosed" });
    }
  });

  // an evaluation backend is not implemented; say so rather than invent numbers
  router.get("/evaluations", (_request: Request, response: Response) => {
    response.json({ status: "not-configured", reason: "no evaluation backend is wired to this deployment" });
  });

  /**
   * Validate a draft and render the whole change-set. PURE: it changes nothing.
   * It runs the same schema the runtime loads at startup, so the management
   * plane cannot propose a file that would fail to load — but the runtime does
   * not open the pull request. Rendering is an execution-plane concern because
   * the execution plane owns the schema; WRITING is not, because the process
   * that enforces Agent policy must not be able to change it.
   */
  router.post("/agents/preview", (request: Request, response: Response) => {
    try {
      const state = deps.state();
      const registry = state.registry;
      const { change, generated } = proposeAgentChange({
        draft: request.body as AgentDraft,
        requestedBy: request.identity?.subject ?? "unknown",
        update: registry.getSpecialist((request.body as AgentDraft)?.name ?? "") !== undefined,
        knownAgents: registry.listSpecialists().map((agent) => agent.name),
        /*
         * THE ENVIRONMENT THIS RUNTIME SERVES, not a compile-time default.
         *
         * The overlay and the rendered Helm values are per environment, and the
         * default was the literal "production". A runtime serving `local`
         * therefore wrote both files into `deploy/environments/production/`,
         * which nothing in that cluster globs: the pull request merged, the
         * portal showed it merged, and Argo never saw an Application because
         * the files had landed in an environment nobody was deploying.
         */
        targetEnvironment: state.environment,
      });
      response.json({ path: generated.path, yaml: generated.yaml, branch: change.branch, title: change.title, body: change.body, effects: change.effects, files: generated.files, diff: diffAgainstDisk(generated.files) });
    } catch (error) {
      respondDraftError(response, error);
    }
  });

  /**
   * Render the change-set that REMOVES an Agent. Pure, like every preview: the
   * files are enumerated from disk, nothing is written, and the management
   * plane opens the pull request. 409 when another Agent still grants this one
   * cross-domain access, because that merge would break configuration loading.
   */
  router.post("/agents/:id/delete/preview", (request: Request, response: Response) => {
    const state = deps.state();
    const name = request.params.id as string;
    const agent = state.registry.getSpecialist(name);
    if (agent === undefined) { notFound(response, "agent"); return; }
    try {
      const change = proposeAgentDeletion({
        agent,
        requestedBy: request.identity?.subject ?? "unknown",
        // every environment directory in the repository, so no overlay survives
        environments: readdirSync(resolveChangePath("deploy/environments"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name),
        others: state.registry.listSpecialists().filter((other) => other.name !== name),
        exists: (path) => existsSync(resolveChangePath(path)),
        read: (path) => readFileSync(resolveChangePath(path), "utf8"),
      });
      response.json({ path: `config/agents/${name}.yaml`, yaml: "", branch: change.branch, title: change.title, body: change.body, effects: change.effects, files: change.files, diff: diffAgainstDisk(change.files) });
    } catch (error) {
      respondDraftError(response, error);
    }
  });

  /**
   * Render a change-set for a prompt edit. PURE, exactly like /agents/preview:
   * the execution plane owns the schema so it renders, and holds no Git
   * credential so it cannot write. The management plane opens the pull request.
   */
  router.post("/agents/:id/prompt/preview", (request: Request, response: Response) => {
    const agent = deps.state().registry.getSpecialist(request.params.id as string);
    if (agent === undefined) { response.status(404).json({ code: "NOT_FOUND", message: "No such agent" }); return; }
    try {
      const prompt = (request.body as { prompt?: unknown })?.prompt;
      if (typeof prompt !== "string") throw new AgentDraftError(["prompt: a system prompt string is required"]);
      const change = proposePromptChange({ agent, prompt, requestedBy: request.identity?.subject ?? "unknown" });
      response.json({ path: change.files[0]?.path, yaml: change.files[0]?.contents, branch: change.branch, title: change.title, body: change.body, effects: change.effects, files: change.files, diff: diffAgainstDisk(change.files) });
    } catch (error) {
      respondDraftError(response, error);
    }
  });

  /**
   * Serve an avatar asset from the repository.
   *
   * The path is taken from the AGENT DOCUMENT, never from the request: the
   * caller names an agent and the runtime looks up what that agent references,
   * so no path arrives from outside. The schema already constrains that value
   * to the two managed directories, and `isManagedAvatarPath` re-checks it here
   * rather than trusting a document loaded earlier.
   */
  router.get("/agents/:id/avatar", (request: Request, response: Response) => {
    const registry = deps.state().registry;
    const agent = registry.getSpecialist(request.params.id as string);
    const avatar = agent?.avatar ?? (request.params.id === "manager" ? registry.manager.avatar : undefined);
    if (avatar === undefined) { notFound(response, "avatar"); return; }
    if (!isManagedAvatarPath(avatar.asset) && !/^assets\/icons\/[a-z][a-z0-9-]*\.(png|jpg|webp)$/u.test(avatar.asset)) {
      notFound(response, "avatar");
      return;
    }
    try {
      // the same base the loader resolves prompt files against, so an asset
      // path in a document means the same thing to both
      const bytes = readFileSync(join(process.cwd(), avatar.asset));
      const asset = validateAvatar(bytes);
      response
        .setHeader("content-type", CONTENT_TYPE[asset.format])
        // immutable for a while: the path changes when the image does, because
        // the extension is derived from the sniffed format
        .setHeader("cache-control", "public, max-age=300")
        .send(bytes);
    } catch {
      notFound(response, "avatar");
    }
  });

  /**
   * Validate an upload WITHOUT committing anything.
   *
   * The console needs to know a file is acceptable before the operator reaches
   * the review step, and the answer has to come from the same code that will
   * later gate the change-set — a second implementation in the browser would be
   * a second opinion, and the browser's would not be the one that counts.
   */
  router.post("/avatar/validate", (request: Request, response: Response) => {
    try {
      const upload = (request.body as { upload?: unknown })?.upload;
      if (typeof upload !== "string") throw new AvatarError("no image was supplied");
      const asset = validateAvatar(Buffer.from(upload, "base64"));
      response.json({ format: asset.format, width: asset.width, height: asset.height, bytes: asset.bytes.length });
    } catch (error) {
      if (error instanceof AvatarError) { response.status(400).json({ code: "AVATAR_INVALID", message: error.reason }); return; }
      response.status(400).json({ code: "AVATAR_INVALID", message: "the image could not be read" });
    }
  });

  /** The curated built-in catalog, so the console does not hard-code a list. */
  router.get("/avatar/icons", (_request: Request, response: Response) => {
    response.json({ icons: BUILT_IN_ICONS });
  });

  /**
   * The Manager. It is not reachable under /agents/:id because it is not a
   * specialist — `getSpecialist("manager")` is undefined by construction, and
   * making it resolve there would mean serving a specialist-shaped view of a
   * document that has no identity, access or routing vocabulary.
   */
  router.get("/manager", (_request: Request, response: Response) => {
    const state = deps.state();
    response.json(managerDetail(state.registry, { environment: state.environment, enabledAgentIds: state.enabledAgentIds }));
  });

  /**
   * Draft a system prompt from the form the operator currently has open.
   *
   * PURE with respect to this platform: it stores nothing, proposes nothing and
   * opens no pull request. The text is returned for the operator to edit, and
   * every guarantee the runtime makes is enforced against configuration rather
   * than against whatever the draft says.
   *
   * The body is projected onto an allowlist before it leaves the process, so a
   * field added to the portal's form later cannot start travelling to a model
   * by accident.
   */
  router.post("/prompt-assist", async (request: Request, response: Response) => {
    if (deps.promptAssistModel === undefined) {
      response.status(501).json({ code: "NOT_CONFIGURED", message: "No prompt-assist model profile is configured for this environment" });
      return;
    }
    try {
      const context = safeContext(request.body);
      const prompt = await draftSystemPrompt(deps.promptAssistModel, context);
      response.json({ prompt });
    } catch (error) {
      if (error instanceof PromptAssistError) {
        response.status(400).json({ code: "PROMPT_ASSIST_INVALID", message: error.reason });
        return;
      }
      // never echo a provider error body: it can disclose endpoints or policy
      response.status(502).json({ code: "PROMPT_ASSIST_UNAVAILABLE", message: "The prompt could not be drafted" });
    }
  });

  /** Render the Manager change-set. PURE, exactly like /agents/preview. */
  router.post("/manager/preview", (request: Request, response: Response) => {
    try {
      const { change, generated } = proposeManagerChange({ draft: request.body as ManagerDraft, current: deps.state().registry.manager, requestedBy: request.identity?.subject ?? "unknown" });
      response.json({ path: generated.path, yaml: generated.yaml, branch: change.branch, title: change.title, body: change.body, effects: change.effects, files: generated.files, diff: diffAgainstDisk(generated.files) });
    } catch (error) {
      respondDraftError(response, error);
    }
  });

  return router;
}

/**
 * Compare every proposed file against what is on disk right now.
 *
 * The comparison happens here because only this process can see the working
 * tree. A file that is not there is an ADDITION rather than a diff against
 * emptiness, so creating an agent does not read as a hundred changed lines.
 *
 * A read failure is treated as "not there": failing a preview because of a
 * permissions problem would block a review over something the reviewer cannot
 * act on, and the change-set is still perfectly reviewable as an addition.
 */
/**
 * A change-set path is relative to the REPOSITORY; the runtime does not run at
 * its root. `fromRepoPath` is the single inverse of the mapping the generator
 * applies, so the diff can never disagree with what will be committed.
 */
function resolveChangePath(path: string): string {
  return join(process.cwd(), fromRepoPath(path));
}

function diffAgainstDisk(files: readonly { path: string; contents: string; encoding?: "base64"; deleted?: boolean }[]): ChangeSetDiff {
  return summarise(
    files.map((file) => {
      let current: string | undefined;
      try {
        current = readFileSync(resolveChangePath(file.path), "utf8");
      } catch {
        current = undefined;
      }
      // a deletion diffs the file against nothing, which is what "deleted" means to the diff
      return diffFile(file.path, current, file.deleted === true ? undefined : file.contents, file.encoding === "base64");
    }),
  );
}

/**
 * EVERY ROUTE THAT USES THIS IS A PREVIEW.
 *
 * They render YAML and diff it against disk; none of them opens a pull request,
 * because the Manager never talks to the GitOps provider — the portal backend
 * owns that publisher. This used to answer GITOPS_UNAVAILABLE for any error
 * that was not an AgentDraftError, which told an operator that GitHub, their
 * token or their network was at fault for what was an invalid form. Observed in
 * the portal against a token that was valid, `repo`-scoped and holding push
 * permission on the target repository.
 *
 * A subsystem that this process cannot reach cannot be the one it reports as
 * unavailable. The provider's own error text is still never echoed: it can
 * disclose policy or infrastructure internals.
 */
function respondDraftError(response: Response, error: unknown): void {
  if (error instanceof AgentDraftError) {
    response.status(400).json({ code: "AGENT_DRAFT_INVALID", message: "Agent draft failed validation", issues: error.issues });
    return;
  }
  /*
   * The CLIENT still learns nothing about the failure — a render error can name
   * paths and configuration this API deliberately does not expose. But the
   * OPERATOR must, and until now nothing was written anywhere: the first
   * version of this handler blamed GitOps, and the second said only "could not
   * be rendered", so a real failure in the console left no trace on the server
   * either. An error nobody can see is the one that stays.
   */
  console.error(JSON.stringify({
    level: "error",
    event: "management.draft.render_failed",
    detail: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack.split("\n").slice(0, 4).join(" | ") } : {}),
  }));
  response.status(400).json({ code: "AGENT_DRAFT_INVALID", message: "The draft could not be rendered" });
}

function notFound(response: Response, kind: string): void {
  response.status(404).json({ code: "NOT_FOUND", message: `No such ${kind}` });
}
