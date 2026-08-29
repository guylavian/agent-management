import { Router, type Request, type Response } from "express";
import type { AgentRegistry, AppConfig } from "@sre/config";
import {
  agentDetail,
  agentSummary,
  AgentDraftError,
  managerDetail,
  mcpServerViews,
  permissionMatrix,
  proposeAgentChange,
  proposeManagerChange,
  proposePromptChange,
  type AgentDraft,
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
      response.json({ path: generated.path, yaml: generated.yaml, branch: change.branch, title: change.title, body: change.body, effects: change.effects, files: generated.files });
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
      response.json({ path: change.files[0]?.path, yaml: change.files[0]?.contents, branch: change.branch, title: change.title, body: change.body, effects: change.effects, files: change.files });
    } catch (error) {
      respondDraftError(response, error);
    }
  });

  /**
   * The Manager. It is not reachable under /agents/:id because it is not a
   * specialist — `getSpecialist("manager")` is undefined by construction, and
   * making it resolve there would mean serving a specialist-shaped view of a
   * document that has no identity, access or routing vocabulary.
   */
  router.get("/manager", (_request: Request, response: Response) => {
    response.json(managerDetail(deps.registry));
  });

  /** Render the Manager change-set. PURE, exactly like /agents/preview. */
  router.post("/manager/preview", (request: Request, response: Response) => {
    try {
      const { change, generated } = proposeManagerChange({ draft: request.body as ManagerDraft, current: deps.registry.manager, requestedBy: request.identity?.subject ?? "unknown" });
      response.json({ path: generated.path, yaml: generated.yaml, branch: change.branch, title: change.title, body: change.body, effects: change.effects, files: generated.files });
    } catch (error) {
      respondDraftError(response, error);
    }
  });

  return router;
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
