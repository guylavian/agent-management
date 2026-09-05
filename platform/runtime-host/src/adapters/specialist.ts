import { runAgent, type AgentRunContext, type EngineDependencies } from "@sre/agent-engine";
import { workloadIdentitySchema, type ToolCredentialExchanger } from "@sre/auth";
import type { AgentRegistry, ApprovedCatalog, SpecialistAgentConfig } from "@sre/config";
import type { DomainHandoff, SpecialistResult } from "@sre/evidence";
import type { ModelClient } from "@sre/llm";
import { platformSanitizer, platformTelemetry, toAgentDefinition, toCredentialProvider, toToolPolicy } from "./ports.ts";
import { withCredentialRefresh } from "./toolhive.ts";
import type { ToolHiveClient } from "./toolhive.ts";

/**
 * Running a Specialist, in this platform's terms.
 *
 * The engine takes an AgentDefinition, a ToolPolicy and its ports. This is the
 * one place that turns "the keycloak Agent, from the mounted registry, against
 * ToolHive, with Keycloak-issued workload credentials" into those things — so
 * both transports compose the engine identically and neither can drift into a
 * weaker configuration than the other.
 */
export interface SpecialistRuntimeDependencies {
  model: ModelClient;
  toolhive: ToolHiveClient;
  credentialExchanger?: ToolCredentialExchanger;
}

function engineDependencies(agent: SpecialistAgentConfig, ctx: AgentRunContext, deps: SpecialistRuntimeDependencies): EngineDependencies {
  const definition = toAgentDefinition(agent);
  const exchanger = deps.credentialExchanger;
  // The engine caches one credential per server for the whole run, so a run
  // longer than the credential's lifetime would present a dead token. This is
  // the only place that holds the agent's real workload identity, the real
  // delegated human and the run's deadline, so the refresh closure is built
  // HERE and the adapter is never in a position to invent any of them.
  const tools = exchanger === undefined || definition.workload === undefined
    ? deps.toolhive
    : withCredentialRefresh(deps.toolhive, async (audience) => exchanger.exchange(
      // validated, not cast: a workload that is not a valid platform identity
      // fails here rather than reaching the identity provider
      workloadIdentitySchema.parse({ ...definition.workload, agentId: definition.id }),
      { subject: ctx.principal.subject, groups: ctx.principal.groups ?? [], roles: ctx.principal.roles, requestId: ctx.principal.requestId },
      audience,
      ctx.deadline,
      ctx.signal,
    ));
  return {
    model: deps.model,
    tools,
    // redaction is required by the port, so it cannot be forgotten here
    sanitizer: platformSanitizer,
    telemetry: platformTelemetry,
    ...(exchanger ? { credentials: toCredentialProvider(exchanger) } : {}),
  };
}

/** Run one already-resolved Specialist. This is what a specialist process uses. */
export async function runSpecialistInstance(agent: SpecialistAgentConfig, catalog: ApprovedCatalog, ctx: AgentRunContext, deps: SpecialistRuntimeDependencies, handoff?: DomainHandoff): Promise<SpecialistResult> {
  return runAgent(toAgentDefinition(agent), toToolPolicy(catalog), ctx, engineDependencies(agent, ctx, deps), handoff);
}

/** Resolve a Specialist by id from a mounted registry, then run it. */
export async function runSpecialist(agentId: string, ctx: AgentRunContext, deps: SpecialistRuntimeDependencies & { registry: AgentRegistry }, handoff?: DomainHandoff): Promise<SpecialistResult> {
  const agent = deps.registry.getSpecialist(agentId);
  if (agent === undefined) return { agentId, status: "failed", evidence: [], errors: [{ code: "ROUTE_INVALID", message: "Selected specialist is unavailable", retryable: false }] };
  return runSpecialistInstance(agent, deps.registry.catalog, ctx, deps, handoff);
}
