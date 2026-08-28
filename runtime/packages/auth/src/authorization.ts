import { audienceFor, isAgentEnabled, isToolAllowed, type AgentRegistry, type ApprovedTool, type SpecialistAgentConfig } from "@sre/config";
import type { RequestIdentity } from "./identity.ts";

export interface AuthorizationDecision {
  allowed: boolean;
  code: "ALLOWED" | "AUTHZ_DENIED";
}

export class AuthorizationService {
  readonly registry?: AgentRegistry;
  constructor(registry?: AgentRegistry) { this.registry = registry; }

  /**
   * Human → Agent authorization. A non-active Agent is denied here regardless of
   * the caller's roles, so disabling an Agent stops execution and not merely
   * Manager routing — TDD §34.
   */
  authorizeAgent(identity: RequestIdentity, agent: SpecialistAgentConfig, _environment: string): AuthorizationDecision {
    const allowed = isAgentEnabled(agent.spec)
      && agent.spec.authorization.requiredRoles.every((role) => identity.roles.includes(role));
    return { allowed, code: allowed ? "ALLOWED" : "AUTHZ_DENIED" };
  }

  filterAuthorizedAgents(identity: RequestIdentity, requested: string[], environment: string): string[] {
    if (this.registry === undefined) throw new Error("agent registry is required for manager authorization filtering");
    return [...new Set(requested)].filter((id) => {
      const agent = this.registry?.getSpecialist(id);
      return agent !== undefined && this.authorizeAgent(identity, agent, environment).allowed;
    });
  }

  /**
   * Agent → MCP → Tool authorization, evaluated before every call — TDD §39.
   * Scoping is per MCP: a tool granted on one server is not thereby granted on
   * another exposing the same tool name.
   */
  preflightTool(identity: RequestIdentity, agent: SpecialistAgentConfig, tool: ApprovedTool, environment: string): AuthorizationDecision {
    const allowed = this.authorizeAgent(identity, agent, environment).allowed
      && isToolAllowed(agent.spec, tool.serverId, tool.toolName)
      && tool.readOnlyVerified
      && agent.spec.security.readOnly
      && tool.environments.includes(environment);
    return { allowed, code: allowed ? "ALLOWED" : "AUTHZ_DENIED" };
  }

  /**
   * Audience → resource binding. The credential presented for an MCP call must
   * be scoped to exactly the audience this Agent's policy declares for that MCP,
   * so a token minted for one ToolHive resource cannot be replayed against
   * another — TDD §9/§12.
   */
  authorizeAudience(agent: SpecialistAgentConfig, serverId: string, credentialAudience: string): AuthorizationDecision {
    const expected = audienceFor(agent.spec, serverId);
    const allowed = expected !== undefined && expected === credentialAudience;
    return { allowed, code: allowed ? "ALLOWED" : "AUTHZ_DENIED" };
  }
}
