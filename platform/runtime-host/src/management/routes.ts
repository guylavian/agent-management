import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Router, type Request, type Response } from "express";
import { fromRepoPath, type AgentRegistry, type AppConfig } from "@sre/config";
import type { ModelClient } from "@sre/llm";
import {
  agentDetail,
  agentSummary,
  AgentDraftError,
  AvatarError,
  BUILT_IN_ICONS,
  CONTENT_TYPE,
  diagnoseRun,
  diffFile,
  draftSystemPrompt,
  isManagedAvatarPath,
  managerDetail,
  mcpServerViews,
  permissionMatrix,
  proposeAgentChange,
  proposeManagerChange,
  RunDiagnosisError,
  proposePromptChange,
  PromptAssistError,
  safeContext,
  summarise,
  validateAvatar,
  type AgentDraft,
  type ChangeSetDiff,
  type ManagerDraft,
  type RunStore,
} from "./index.ts";

/**
 * Read-only management API (TDD §43). Mounted only on the Manager, which is the
 * process that holds the full agent registry.
 *
 * It is a projection of configuration and bounded run metadata. It never
 * exposes tokens, secrets, credentials, model reasoning or unredacted tool
 * output, and it performs no mutation: an Agent changes by merging a pull
 * request, not by calling this API.
 */
export interface ManagementDeps {
  registry: AgentRegistry;
  config: AppConfig;
  runs: RunStore;
  /**
   * Backs console assistance only, on the platform `prompt-assist` profile.
   * Optional: a deployment that does not want a drafting aid simply omits it,
   * and the endpoint reports that rather than falling back to an Agent's model.
   */
  promptAssistModel?: ModelClient;
  /**
   * What this environment actually runs, as opposed to what the Agent documents
   * declare. `registry` above is the CANONICAL set — every Agent that exists —
   * which is right for a management plane that must be able to show and edit an
   * agent this cluster does not deploy. It is wrong as an answer to "can the
   * Manager reach this", and the console was reading it as though it were.
   */
  deployment?: { environment: string; enabledAgentIds: string[] };
}

export function managementRouter(deps: ManagementDeps): Router {
  const router = Router();
  const specialists = () => deps.registry.listSpecialists();

  router.get("/agents", (_request: Request, response: Response) => {
    response.json({ agents: specialists().map(agentSummary) });
  });

  router.get("/agents/:id", (request: Request, response: Response) => {
    const agent = deps.registry.getSpecialist(request.params.id as string);
    if (agent === undefined) { notFound(response, "agent"); return; }
    response.json(agentDetail(agent, deps.registry.catalog));
  });

  /**
   * Configured posture, not a live probe. Reporting "healthy" here without
   * having asked the Agent would be fabricated telemetry, so reachability is
   * explicitly reported as unknown until a probe exists.
   */
  router.get("/agents/:id/health", (request: Request, response: Response) => {
    const agent = deps.registry.getSpecialist(request.params.id as string);
    if (agent === undefined) { notFound(response, "agent"); return; }
    response.json({
      agentId: agent.name,
      lifecycle: agent.spec.lifecycle,
      routable: deps.registry.manager.spec.agents.allowed.includes(agent.name),
      reachability: "unknown",
      reason: "runtime health probing is not configured",
    });
  });

  router.get("/agents/:id/metrics", (request: Request, response: Response) => {
    const agent = deps.registry.getSpecialist(request.params.id as string);
    if (agent === undefined) { notFound(response, "agent"); return; }
    const runs = deps.runs.list(200).filter((run) => run.agents.includes(agent.name));
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
    response.json({ servers: mcpServerViews(specialists(), deps.registry.catalog, deps.config.toolhive.endpoints) });
  });

  router.get("/permissions", (_request: Request, response: Response) => {
    response.json(permissionMatrix(specialists(), deps.registry.catalog));
  });

  router.get("/runs", (request: Request, response: Response) => {
    const limit = Number.parseInt(String(request.query.limit ?? "50"), 10);
    response.json({ runs: deps.runs.list(Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50) });
  });

  router.get("/runs/:id", (request: Request, response: Response) => {
    const run = deps.runs.get(request.params.id as string);
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
    const run = deps.runs.get(request.params.id as string);
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
      const { change, generated } = proposeAgentChange({ draft: request.body as AgentDraft, requestedBy: request.identity?.subject ?? "unknown", update: deps.registry.getSpecialist((request.body as AgentDraft)?.name ?? "") !== undefined });
      response.json({ path: generated.path, yaml: generated.yaml, branch: change.branch, title: change.title, body: change.body, effects: change.effects, files: generated.files, diff: diffAgainstDisk(generated.files) });
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
    const agent = deps.registry.getSpecialist(request.params.id as string);
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
    const agent = deps.registry.getSpecialist(request.params.id as string);
    const avatar = agent?.avatar ?? (request.params.id === "manager" ? deps.registry.manager.avatar : undefined);
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
    response.json(managerDetail(deps.registry, deps.deployment));
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
      const { change, generated } = proposeManagerChange({ draft: request.body as ManagerDraft, current: deps.registry.manager, requestedBy: request.identity?.subject ?? "unknown" });
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

function diffAgainstDisk(files: readonly { path: string; contents: string; encoding?: "base64" }[]): ChangeSetDiff {
  return summarise(
    files.map((file) => {
      let current: string | undefined;
      try {
        current = readFileSync(resolveChangePath(file.path), "utf8");
      } catch {
        current = undefined;
      }
      return diffFile(file.path, current, file.contents, file.encoding === "base64");
    }),
  );
}

function respondDraftError(response: Response, error: unknown): void {
  if (error instanceof AgentDraftError) {
    response.status(400).json({ code: "AGENT_DRAFT_INVALID", message: "Agent draft failed validation", issues: error.issues });
    return;
  }
  // never echo a provider error body: it can disclose policy or infrastructure internals
  response.status(502).json({ code: "GITOPS_UNAVAILABLE", message: "The change could not be proposed" });
}

function notFound(response: Response, kind: string): void {
  response.status(404).json({ code: "NOT_FOUND", message: `No such ${kind}` });
}
