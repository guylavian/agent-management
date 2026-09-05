import { audienceFor, audienceScopeName, isAgentEnabled, toolRoleName, workloadClientId, type SpecialistAgentConfig } from "@sre/agent-schema";

// canonical derivations live in the contract; re-exported for provisioning callers
export { audienceScopeName, toolRoleName } from "@sre/agent-schema";

/**
 * Agent definition → desired Keycloak state (TDD §31).
 *
 * This module is a pure function of the canonical Agent policy: it never talks
 * to Keycloak and never reads a credential. Provisioning belongs to the
 * management/configuration path; runtime token acquisition is a separate
 * concern that only consumes the state described here.
 *
 * Audience isolation (TDD §9) is modelled with ONE OPTIONAL CLIENT SCOPE PER
 * MCP rather than several audience mappers on the client. Mappers on the client
 * itself would put every audience into every token — exactly the
 * `aud = all-mcps` design the architecture forbids. As optional scopes, the
 * workload asks for one scope per call and Keycloak mints a token whose `aud`
 * is only that MCP's ToolHive resource.
 */

export interface DesiredAudienceScope {
  /** client-scope name, e.g. sre-toolhive-keycloak */
  name: string;
  /** audience claim it injects, e.g. sre-toolhive:keycloak */
  audience: string;
  mcp: string;
}

export interface DesiredClient {
  clientId: string;
  name: string;
  description: string;
  /** false whenever lifecycle is not active — token issuance stops with routing (TDD §34) */
  enabled: boolean;
  /** confidential service-account client: the Agent's workload identity (TDD §7/§8) */
  serviceAccountsEnabled: true;
  standardFlowEnabled: false;
  directAccessGrantsEnabled: false;
  publicClient: false;
  /** optional so a token carries exactly one MCP audience */
  optionalClientScopes: DesiredAudienceScope[];
  /** Agent → MCP → Tool grants as client roles, e.g. keycloak:list_clients (TDD §10) */
  roles: DesiredClientRole[];
  attributes: Record<string, string>;
}

export interface DesiredClientRole {
  name: string;
  description: string;
  mcp: string;
  tool: string;
}

export function desiredClientFor(agent: SpecialistAgentConfig): DesiredClient {
  const roles: DesiredClientRole[] = [];
  const optionalClientScopes: DesiredAudienceScope[] = [];
  for (const entry of agent.spec.access) {
    const audience = audienceFor(agent.spec, entry.mcp);
    if (audience === undefined) continue;
    optionalClientScopes.push({ name: audienceScopeName(entry.mcp), audience, mcp: entry.mcp });
    for (const tool of entry.tools) {
      roles.push({ name: toolRoleName(entry.mcp, tool), description: `read-only ${tool} on ${entry.mcp}`, mcp: entry.mcp, tool });
    }
  }
  return {
    clientId: agent.spec.identity.clientId,
    name: agent.spec.identity.clientId,
    description: `Workload identity for the ${agent.name} SRE specialist agent`,
    enabled: isAgentEnabled(agent.spec),
    serviceAccountsEnabled: true,
    standardFlowEnabled: false,
    directAccessGrantsEnabled: false,
    publicClient: false,
    optionalClientScopes,
    roles,
    attributes: {
      "sre.agent.id": agent.name,
      "sre.agent.owner": agent.owner,
      "sre.agent.lifecycle": agent.spec.lifecycle,
      // short-lived tokens (TDD §9); seconds, matches the runtime credential TTL
      "access.token.lifespan": "60",
      // RFC 8693 token exchange: required for the actor to exchange a subject token (TDD §31)
      "standard.token.exchange.enabled": "true",
    },
  };
}

export function desiredClientsFor(agents: SpecialistAgentConfig[]): DesiredClient[] {
  const byClientId = new Map<string, DesiredClient>();
  for (const agent of agents) {
    const expected = workloadClientId(agent.name);
    if (agent.spec.identity.clientId !== expected) {
      throw new Error(`agent ${agent.name} declares workload client ${agent.spec.identity.clientId}, expected ${expected}`);
    }
    if (byClientId.has(expected)) throw new Error(`duplicate workload client ${expected}`);
    byClientId.set(expected, desiredClientFor(agent));
  }
  return [...byClientId.values()];
}
