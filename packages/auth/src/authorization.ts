import type { AgentRegistry, ApprovedTool, SpecialistAgentConfig } from "@sre/config";
import type { RequestIdentity } from "./identity.ts";

export interface AuthorizationDecision {
  allowed: boolean;
  code: "ALLOWED" | "AUTHZ_DENIED";
}

export class AuthorizationService {
  readonly registry?: AgentRegistry;
  constructor(registry?: AgentRegistry) { this.registry = registry; }

  authorizeAgent(identity: RequestIdentity, agent: SpecialistAgentConfig, _environment: string): AuthorizationDecision {
    const allowed = agent.spec.authorization.requiredRoles.every((role) => identity.roles.includes(role));
    return { allowed, code: allowed ? "ALLOWED" : "AUTHZ_DENIED" };
  }

  filterAuthorizedAgents(identity: RequestIdentity, requested: string[], environment: string): string[] {
    if (this.registry === undefined) throw new Error("agent registry is required for manager authorization filtering");
    return [...new Set(requested)].filter((id) => {
      const agent = this.registry?.getSpecialist(id);
      return agent !== undefined && this.authorizeAgent(identity, agent, environment).allowed;
    });
  }

  preflightTool(identity: RequestIdentity, agent: SpecialistAgentConfig, tool: ApprovedTool, environment: string): AuthorizationDecision {
    const allowed = this.authorizeAgent(identity, agent, environment).allowed
      && agent.spec.mcp.servers.includes(tool.serverId)
      && agent.spec.mcp.allowedTools.includes(tool.toolName)
      && tool.readOnlyVerified
      && tool.environments.includes(environment);
    return { allowed, code: allowed ? "ALLOWED" : "AUTHZ_DENIED" };
  }
}
