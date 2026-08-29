import { runAgent, type AgentRunContext, type EngineDependencies } from "@sre/agent-engine";
import type { ToolCredentialExchanger } from "@sre/auth";
import type { AgentRegistry, ApprovedCatalog, SpecialistAgentConfig } from "@sre/config";
import type { DomainHandoff, SpecialistResult } from "@sre/evidence";
import type { ModelClient } from "@sre/llm";
import { platformSanitizer, platformTelemetry, toAgentDefinition, toCredentialProvider, toToolPolicy } from "./ports.ts";
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

function engineDependencies(deps: SpecialistRuntimeDependencies): EngineDependencies {
  return {
    model: deps.model,
    tools: deps.toolhive,
    // redaction is required by the port, so it cannot be forgotten here
    sanitizer: platformSanitizer,
    telemetry: platformTelemetry,
    ...(deps.credentialExchanger ? { credentials: toCredentialProvider(deps.credentialExchanger) } : {}),
  };
}

/** Run one already-resolved Specialist. This is what a specialist process uses. */
export async function runSpecialistInstance(agent: SpecialistAgentConfig, catalog: ApprovedCatalog, ctx: AgentRunContext, deps: SpecialistRuntimeDependencies, handoff?: DomainHandoff): Promise<SpecialistResult> {
  return runAgent(toAgentDefinition(agent), toToolPolicy(catalog), ctx, engineDependencies(deps), handoff);
}

/** Resolve a Specialist by id from a mounted registry, then run it. */
export async function runSpecialist(agentId: string, ctx: AgentRunContext, deps: SpecialistRuntimeDependencies & { registry: AgentRegistry }, handoff?: DomainHandoff): Promise<SpecialistResult> {
  const agent = deps.registry.getSpecialist(agentId);
  if (agent === undefined) return { agentId, status: "failed", evidence: [], errors: [{ code: "ROUTE_INVALID", message: "Selected specialist is unavailable", retryable: false }] };
  return runSpecialistInstance(agent, deps.registry.catalog, ctx, deps, handoff);
}
