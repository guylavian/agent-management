import { Router, type Request, type Response } from "express";
import type { AgentRegistry, AppConfig } from "@sre/config";
import {
  agentDetail,
  agentSummary,
  mcpServerViews,
  permissionMatrix,
  type RunStore,
} from "@sre/management-api";

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

  return router;
}

function notFound(response: Response, kind: string): void {
  response.status(404).json({ code: "NOT_FOUND", message: `No such ${kind}` });
}
