import { subjectHash } from "@sre/auth";
import type { AgentRegistry, ApprovedCatalog, SpecialistAgentConfig } from "@sre/config";
import type { DomainHandoff, SpecialistResult } from "@sre/evidence";
import { incrementMetric, withSpan } from "@sre/telemetry";
import { failed } from "./evidence/results.ts";
import { runSpecialistLoop } from "./investigation/loop.ts";
import type { SpecialistEngineDependencies, SpecialistExecutionContext } from "./types.ts";

/**
 * The Specialist Agent engine.
 *
 * One implementation runs every specialist. Which domain it is, which prompt it
 * uses, which MCP servers and tools it may reach, which other domain it may ask
 * for and every budget it must respect are read from the canonical Agent
 * configuration — never from code, and never from the caller.
 *
 * The engine has no knowledge of the Manager. It cannot route, cannot select
 * another agent and cannot call one; the strongest cross-domain signal it can
 * produce is `needsDomain`, which is a request the Manager may refuse.
 */
export interface SpecialistDependencies extends SpecialistEngineDependencies {
  registry: AgentRegistry;
}

/** Resolve the specialist by id from a mounted registry, then run it. */
export async function runSpecialist(agentId: string, ctx: SpecialistExecutionContext, deps: SpecialistDependencies, handoff?: DomainHandoff): Promise<SpecialistResult> {
  const agent = deps.registry.getSpecialist(agentId);
  if (agent === undefined) return failed(agentId, "ROUTE_INVALID", "Selected specialist is unavailable");
  return runSpecialistInstance(agent, deps.registry.catalog, ctx, deps, handoff);
}

/** Run one already-resolved specialist. This is the entry point a specialist process uses. */
export async function runSpecialistInstance(agent: SpecialistAgentConfig, catalog: ApprovedCatalog, ctx: SpecialistExecutionContext, deps: SpecialistEngineDependencies, handoff?: DomainHandoff): Promise<SpecialistResult> {
  incrementMetric("sre_specialist_invocations_total");
  return withSpan(`agent.${agent.name}.execute`, { "request.id": ctx.requestId, "user.subject_hash": subjectHash(ctx.identity.subject), "agent.id": agent.name, environment: ctx.environment }, () => runSpecialistLoop(agent, catalog, ctx, deps, handoff));
}
