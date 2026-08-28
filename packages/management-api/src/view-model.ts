import {
  accessServers,
  audienceFor,
  classifyTool,
  isAgentEnabled,
  isToolAllowed,
  type AgentLifecycle,
  type ApprovedCatalog,
  type SpecialistAgentConfig,
  type ToolClassification,
} from "@sre/agent-schema";
import { audienceScopeName, toolRoleName } from "@sre/keycloak-provisioning";

/**
 * Read-only projections of the canonical Agent policy for the management plane
 * (TDD §43). Everything here is derived from configuration the runtime already
 * loads, so the portal cannot show a permission the runtime would not enforce.
 *
 * Nothing in this module may expose a token, a secret, a raw credential, model
 * reasoning, or unredacted tool output.
 */

export interface McpAccessView {
  mcp: string;
  allowed: boolean;
  audience?: string;
  allowedTools: ToolView[];
  /** approved-catalog tools on this MCP the agent is NOT granted */
  blockedTools: ToolView[];
  /** Keycloak client scope that mints this audience */
  audienceScope?: string;
}

export interface ToolView {
  name: string;
  classification: ToolClassification;
  /** the Keycloak client role representing this grant, when granted */
  role?: string;
}

export interface AgentSummaryView {
  id: string;
  displayName: string;
  owner: string;
  lifecycle: AgentLifecycle;
  enabled: boolean;
  modelProfile: string;
  modelTier: string;
  mcpCount: number;
  toolCount: number;
  workloadClientId: string;
  readOnly: boolean;
}

export interface AgentDetailView extends AgentSummaryView {
  promptFile: string;
  requiredRoles: string[];
  crossDomainAllowed: string[];
  limits: Record<string, number>;
  access: McpAccessView[];
  identity: { provider: string; clientId: string; authentication: string; tokenPolicy: string };
}

export interface McpServerView {
  id: string;
  toolCount: number;
  /** every approved tool on this server, with its classification */
  tools: ToolView[];
  /** agents whose canonical policy grants them this MCP */
  agents: string[];
  expectedAudience: string;
  audienceScope: string;
  /** true only when every approved tool on the server is read-only-verified */
  readOnlyVerified: boolean;
  /** configured ToolHive proxy endpoint, when the runtime has one */
  toolhiveEndpoint?: string;
}

export interface PermissionCellView {
  agent: string;
  mcp: string;
  allowed: boolean;
  toolCount: number;
}

export function agentSummary(agent: SpecialistAgentConfig): AgentSummaryView {
  return {
    id: agent.name,
    displayName: agent.displayName ?? titleCase(agent.name),
    owner: agent.owner,
    lifecycle: agent.spec.lifecycle,
    enabled: isAgentEnabled(agent.spec),
    modelProfile: agent.spec.model.profile,
    modelTier: agent.spec.model.tier,
    mcpCount: agent.spec.access.length,
    toolCount: agent.spec.access.reduce((total, entry) => total + entry.tools.length, 0),
    workloadClientId: agent.spec.identity.clientId,
    readOnly: agent.spec.security.readOnly,
  };
}

export function agentDetail(agent: SpecialistAgentConfig, catalog: ApprovedCatalog): AgentDetailView {
  return {
    ...agentSummary(agent),
    promptFile: agent.spec.prompt.systemFile,
    requiredRoles: agent.spec.authorization.requiredRoles,
    crossDomainAllowed: agent.spec.discovery?.allowedNeedsDomains ?? [],
    limits: { ...agent.spec.execution },
    access: mcpAccessViews(agent, catalog),
    identity: {
      provider: agent.spec.identity.provider,
      clientId: agent.spec.identity.clientId,
      authentication: "service account (confidential client)",
      tokenPolicy: "short-lived, one MCP audience per token",
    },
  };
}

/**
 * The Identity & Access view: every MCP in the approved catalog, marked allowed
 * or not for this Agent. MCPs the Agent cannot reach are listed explicitly
 * rather than omitted, because "not shown" and "denied" must not look alike.
 */
export function mcpAccessViews(agent: SpecialistAgentConfig, catalog: ApprovedCatalog): McpAccessView[] {
  const granted = new Set(accessServers(agent.spec));
  return allMcpIds(catalog).map((mcp) => {
    const toolsOnServer = catalog.tools.filter((tool) => tool.serverId === mcp).map((tool) => tool.toolName);
    const allowedTools: ToolView[] = [];
    const blockedTools: ToolView[] = [];
    for (const name of toolsOnServer) {
      const view: ToolView = { name, classification: classifyTool(catalog, mcp, name) };
      if (granted.has(mcp) && isToolAllowed(agent.spec, mcp, name)) allowedTools.push({ ...view, role: toolRoleName(mcp, name) });
      else blockedTools.push(view);
    }
    const audience = audienceFor(agent.spec, mcp);
    return {
      mcp,
      allowed: granted.has(mcp),
      ...(audience ? { audience, audienceScope: audienceScopeName(mcp) } : {}),
      allowedTools,
      blockedTools,
    };
  });
}

export function mcpServerViews(agents: SpecialistAgentConfig[], catalog: ApprovedCatalog, toolhiveEndpoints: Record<string, string> = {}): McpServerView[] {
  return allMcpIds(catalog).map((mcp) => {
    const tools = catalog.tools.filter((tool) => tool.serverId === mcp);
    const endpoint = toolhiveEndpoints[mcp];
    return {
      id: mcp,
      toolCount: tools.length,
      tools: tools.map((tool) => ({ name: tool.toolName, classification: classifyTool(catalog, mcp, tool.toolName) })),
      agents: agents.filter((agent) => accessServers(agent.spec).includes(mcp)).map((agent) => agent.name),
      expectedAudience: `sre-toolhive:${mcp}`,
      audienceScope: audienceScopeName(mcp),
      readOnlyVerified: tools.every((tool) => tool.readOnlyVerified),
      ...(endpoint ? { toolhiveEndpoint: endpoint } : {}),
    };
  });
}

/** Agent → MCP matrix, readable from both directions (TDD §23). */
export function permissionMatrix(agents: SpecialistAgentConfig[], catalog: ApprovedCatalog): { mcps: string[]; rows: Array<{ agent: string; cells: PermissionCellView[] }> } {
  const mcps = allMcpIds(catalog);
  return {
    mcps,
    rows: agents.map((agent) => ({
      agent: agent.name,
      cells: mcps.map((mcp) => {
        const entry = agent.spec.access.find((item) => item.mcp === mcp);
        return { agent: agent.name, mcp, allowed: entry !== undefined, toolCount: entry?.tools.length ?? 0 };
      }),
    })),
  };
}

export function allMcpIds(catalog: ApprovedCatalog): string[] {
  return [...new Set(catalog.tools.map((tool) => tool.serverId))].sort();
}

function titleCase(name: string): string {
  return name.replace(/(^|-)([a-z])/gu, (_match, separator: string, letter: string) => `${separator === "-" ? " " : ""}${letter.toUpperCase()}`);
}
