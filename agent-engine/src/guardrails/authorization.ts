import { audienceFor, isToolAllowed, type AgentDefinition } from "../agent/definition.ts";
import type { Principal } from "../agent/principal.ts";
import type { ApprovedTool } from "../tools/port.ts";

/**
 * Runtime authorization — owned by the engine, not injected.
 *
 * These are the decisions that make an Agent safe, so they are code in the
 * component that executes tools rather than a port a host could satisfy with a
 * permissive object. Every input is data the host supplied at construction; the
 * model contributes nothing to any branch below.
 *
 * A host layers its own policy by narrowing what it puts in the AgentDefinition
 * and the ApprovedTool list. It cannot widen these.
 */
export interface AuthorizationDecision {
  allowed: boolean;
  code: "ALLOWED" | "AUTHZ_DENIED";
}

const decision = (allowed: boolean): AuthorizationDecision => ({ allowed, code: allowed ? "ALLOWED" : "AUTHZ_DENIED" });

/**
 * Principal → Agent. A disabled Agent is denied here regardless of the caller's
 * roles, so disabling an Agent stops execution and not merely routing.
 */
export function authorizeAgent(principal: Principal, agent: AgentDefinition): AuthorizationDecision {
  return decision(agent.enabled && agent.requiredRoles.every((role) => principal.roles.includes(role)));
}

/**
 * Agent → server → tool, evaluated before every call. Each conjunct is an
 * independent enforcement layer and none of them is redundant: the catalog says
 * the tool was verified read-only, the Agent's own posture says it may call
 * read-only tools at all, its access policy says this tool on THIS server, and
 * the environment list says here.
 */
export function authorizeTool(principal: Principal, agent: AgentDefinition, tool: ApprovedTool, environment: string): AuthorizationDecision {
  return decision(
    authorizeAgent(principal, agent).allowed
    && isToolAllowed(agent, tool.serverId, tool.toolName)
    && tool.readOnlyVerified
    && agent.readOnly
    && tool.environments.includes(environment),
  );
}

/**
 * Audience → resource binding. The credential presented for a call must be
 * bound to exactly the audience this Agent's policy declares for that server, so
 * a credential minted for one resource cannot be replayed against another.
 */
export function authorizeAudience(agent: AgentDefinition, server: string, credentialAudience: string): AuthorizationDecision {
  const expected = audienceFor(agent, server);
  return decision(expected !== undefined && expected === credentialAudience);
}
