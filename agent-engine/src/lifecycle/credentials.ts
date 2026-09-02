import { accessServers, audienceFor, type AgentDefinition } from "../agent/definition.ts";
import type { Principal, ToolCredential } from "../agent/principal.ts";
import { engineError } from "../errors/index.ts";
import { withDeadline } from "../guardrails/deadline.ts";
import type { Telemetry } from "../telemetry/port.ts";

/**
 * The CredentialProvider port — how the Agent's workload obtains a short-lived
 * credential scoped to exactly one downstream resource.
 *
 * Optional: a host with no delegated identity model simply passes none, and the
 * engine calls tools without one. Present, it is the only thing that ever sees
 * a token; the engine holds credentials in a per-run map, keys spans by the
 * AUDIENCE rather than the token, and lets the map fall out of scope when the
 * run ends. Nothing is cached across runs here.
 */
/** The Agent's workload identity as presented to a credential provider. */
export interface WorkloadRef {
  clientId: string;
  provider: string;
  agentId: string;
}

export interface CredentialProvider {
  /** `signal` aborts when the run's deadline expires or the caller cancels; a provider that ignores it is abandoned by the engine's own race. */
  exchange(workload: WorkloadRef | undefined, principal: Principal, audience: string, deadline: number, signal?: AbortSignal): Promise<ToolCredential>;
}

export interface CredentialScope {
  agent: AgentDefinition;
  principal: Principal;
  requestId: string;
  deadline: number;
  telemetry: Telemetry;
  exchanger?: CredentialProvider;
  signal?: AbortSignal;
}

/**
 * Discovery is authenticated too, so one credential per configured server is
 * obtained before listing. allSettled: a server whose exchange fails contributes
 * no credential and therefore no tools, rather than failing the run. Rejections
 * are returned alongside successful credentials so the caller can record them
 * as AUTHN_FAILED errors.
 */
export async function acquireCredentials(scope: CredentialScope): Promise<{ credentials: Map<string, ToolCredential>; failures: Array<{ server: string; error: unknown }> }> {
  const credentials = new Map<string, ToolCredential>();
  const failures: Array<{ server: string; error: unknown }> = [];
  if (scope.exchanger === undefined) return { credentials, failures };
  const servers = accessServers(scope.agent);
  const results = await Promise.allSettled(servers.map(async (server) => {
    const credential = await exchangeFor(scope, server);
    return { server, credential };
  }));
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i]!;
    const server = servers[i]!;
    if (result.status === "fulfilled") {
      if (result.value.credential) credentials.set(result.value.server, result.value.credential);
    } else if (result.status === "rejected") {
      failures.push({ server, error: result.reason });
    }
  }
  return { credentials, failures };
}

/**
 * Obtain the credential for one server, on demand. A server with no declared
 * audience is not in policy, so this denies rather than calling without one.
 */
export async function exchangeFor(scope: CredentialScope, server: string): Promise<ToolCredential | undefined> {
  const exchanger = scope.exchanger;
  if (exchanger === undefined) return undefined;
  const audience = audienceFor(scope.agent, server);
  if (audience === undefined) return undefined;
  // attributes name the workload and the audience; the token itself is never recorded.
  // The deadline guard lives HERE so both call sites — setup acquisition and the
  // on-demand exchange during a tool call — are bounded by the same race.
  return withDeadline(scope.deadline, (signal) => scope.telemetry.span("workload.token", {
    "request.id": scope.requestId,
    "agent.id": scope.agent.id,
    "workload.client_id": scope.agent.workload?.clientId ?? "none",
    "tool.server": server,
    "token.audience": audience,
  }, () => exchanger.exchange(workloadRef(scope.agent), scope.principal, audience, scope.deadline, signal)), scope.signal);
}

/** The Agent's workload, if it has one, named with the Agent it belongs to. */
export function workloadRef(agent: AgentDefinition): WorkloadRef | undefined {
  return agent.workload === undefined ? undefined : { ...agent.workload, agentId: agent.id };
}

/** As {@link exchangeFor}, but a server outside policy is a denial rather than a silent skip. */
export async function requireCredentialFor(scope: CredentialScope, server: string): Promise<ToolCredential> {
  if (audienceFor(scope.agent, server) === undefined) throw engineError("TOOL_DENIED", "Tool access denied");
  const credential = await exchangeFor(scope, server);
  if (credential === undefined) throw engineError("TOOL_DENIED", "Tool access denied");
  return credential;
}
