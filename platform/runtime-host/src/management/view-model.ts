import type { AgentReconciliation } from "./reconciliation.ts";
import {
  accessServers,
  audienceFor,
  classifyTool,
  isAgentEnabled,
  isToolAllowed,
  type AgentLifecycle,
  type ApprovedCatalog,
  type ManagerAgentConfig,
  type SpecialistAgentConfig,
  audienceScopeName,
  toolRoleName,
  type ToolClassification,
} from "@sre/agent-schema";

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
  /**
   * The description already written in the Agent document. It was reachable
   * only from the detail endpoint, so the directory had nothing to say about
   * what an agent is FOR — and a card with no sentence on it is a card that
   * has to be opened to be understood.
   */
  description?: string;
  owner: string;
  lifecycle: AgentLifecycle;
  enabled: boolean;
  modelProfile: string;
  modelTier: string;
  mcpCount: number;
  toolCount: number;
  workloadClientId: string;
  readOnly: boolean;
  /** presentation only; absent means the console falls back to initials */
  avatar?: { asset: string; fit: "cover" | "contain" };
  /**
   * Git desired state joined to actual state. Optional because `agentSummary`
   * is a pure projection of the document and cannot observe a cluster; the
   * route attaches it. Absent means it could not be computed, which is not the
   * same as everything being fine.
   */
  reconciliation?: AgentReconciliation;
}

export interface AgentDetailView extends AgentSummaryView {
  promptFile: string;
  /**
   * The prompt body the runtime actually loaded, not a copy the portal keeps.
   * Serving it here rather than having the portal read Git is deliberate: the
   * console then shows what the running Agent is USING, so a merged-but-unsynced
   * prompt is visibly different from a deployed one.
   */
  prompt: string;
  requiredRoles: string[];
  crossDomainAllowed: string[];
  limits: Record<string, number>;
  access: McpAccessView[];
  identity: { provider: string; clientId: string; authentication: string; tokenPolicy: string };
  /**
   * Everything below exists so the console can rebuild a COMPLETE AgentDraft.
   *
   * Editing an Agent re-renders the whole document from a draft, so any field
   * the console cannot see is a field an edit would silently delete. Routing and
   * capabilities are the dangerous ones — a reviewer would likely approve a diff
   * that quietly dropped them. `tests/create-agent.test.ts` proves the round trip.
   */
  environments: string[];
  routing: { capabilities: string[]; exclusions: string[] };
}

/**
 * The Manager, which is NOT an AgentDetailView and must not pretend to be one.
 *
 * It has no workload identity, no MCP access and no routing vocabulary, because
 * it never calls a tool — that is the design that keeps tool schemas and tool
 * payloads out of the Manager's context. Rendering it through the specialist
 * view would mean inventing those fields, so it gets its own.
 *
 * Like `AgentDetailView`, this is also everything needed to rebuild a complete
 * `ManagerDraft`; `tests/manager-change.test.ts` proves the round trip.
 */
export interface ManagerDetailView {
  id: string;
  displayName?: string;
  description?: string;
  owner: string;
  lifecycle: AgentLifecycle;
  modelProfile: string;
  modelTier: string;
  promptFile: string;
  prompt: string;
  /**
   * THE ROUTING TABLE, DERIVED.
   *
   * It is the effective catalog for this DEPLOYMENT environment: every Agent
   * whose own document is active and whose overlay enables it here. It is not
   * authored anywhere — there used to be a hand-written `agents.allowed` list
   * in the Manager document, and onboarding an Agent silently required a second
   * pull request against it that nothing checked for.
   *
   * A request may still narrow this further by naming a LOGICAL environment
   * (prod, dr, lab), which is a per-request filter on the same catalog rather
   * than a second table.
   */
  routable: string[];
  /** specialists that exist but are NOT routable here, listed rather than omitted */
  notRouted: string[];
  /** the deployment environment this runtime serves; `routable` is relative to it */
  environment: string;
  execution: Record<string, number>;
  /** stated so the console does not leave a blank where a client id would be */
  identity: { provider: "none"; reason: string };
}

export function managerDetail(
  registry: { manager: ManagerAgentConfig; listSpecialists(): SpecialistAgentConfig[] },
  deployment: { environment: string; enabledAgentIds: string[] },
): ManagerDetailView {
  const manager = registry.manager;
  const routable = [...deployment.enabledAgentIds].sort();
  return {
    environment: deployment.environment,
    id: manager.name,
    ...(manager.displayName === undefined ? {} : { displayName: manager.displayName }),
    ...(manager.description === undefined ? {} : { description: manager.description }),
    owner: manager.owner,
    lifecycle: manager.spec.lifecycle,
    modelProfile: manager.spec.model.profile,
    modelTier: manager.spec.model.tier,
    promptFile: manager.spec.prompt.systemFile,
    prompt: manager.systemPrompt,
    routable,
    // "not shown" and "not routable" must not look alike, exactly as with denied MCPs
    notRouted: registry.listSpecialists().map((agent) => agent.name).filter((name) => !routable.includes(name)).sort(),
    execution: { ...manager.spec.execution },
    identity: { provider: "none", reason: "the Manager calls no tool, so it holds no workload credential" },
  };
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
    ...(agent.description === undefined ? {} : { description: agent.description }),
    owner: agent.owner,
    lifecycle: agent.spec.lifecycle,
    enabled: isAgentEnabled(agent.spec),
    modelProfile: agent.spec.model.profile,
    modelTier: agent.spec.model.tier,
    mcpCount: agent.spec.access.length,
    toolCount: agent.spec.access.reduce((total, entry) => total + entry.tools.length, 0),
    workloadClientId: agent.spec.identity.clientId,
    readOnly: agent.spec.security.readOnly,
    ...(agent.avatar === undefined ? {} : { avatar: agent.avatar }),
  };
}

export function agentDetail(agent: SpecialistAgentConfig, catalog: ApprovedCatalog): AgentDetailView {
  return {
    ...agentSummary(agent),
    promptFile: agent.spec.prompt.systemFile,
    prompt: agent.systemPrompt,
    requiredRoles: agent.spec.authorization.requiredRoles,
    crossDomainAllowed: agent.spec.discovery?.allowedNeedsDomains ?? [],
    limits: { ...agent.spec.execution },
    access: mcpAccessViews(agent, catalog),
    ...(agent.description === undefined ? {} : { description: agent.description }),
    environments: agent.spec.environments,
    routing: {
      capabilities: agent.spec.routing.capabilities,
      exclusions: agent.spec.routing.exclusions,
    },
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
  const catalogIds = allMcpIds(catalog);
  // The Agent's OWN declaration order comes first, then everything else it
  // cannot reach. Editing an Agent in the portal rebuilds its document from
  // this view, so any reordering here becomes a spurious diff in the pull
  // request the edit opens — noise that hides the one line actually changed.
  const ids = [...accessServers(agent.spec).filter((mcp) => catalogIds.includes(mcp)), ...catalogIds.filter((mcp) => !granted.has(mcp))];
  return ids.map((mcp) => {
    const declared = agent.spec.access.find((entry) => entry.mcp === mcp)?.tools ?? [];
    const toolsOnServer = catalog.tools.filter((tool) => tool.serverId === mcp).map((tool) => tool.toolName);
    const allowedTools: ToolView[] = [];
    const blockedTools: ToolView[] = [];
    // granted tools in the order the Agent declares them; the rest in catalog order
    for (const name of [...declared.filter((name) => toolsOnServer.includes(name)), ...toolsOnServer.filter((name) => !declared.includes(name))]) {
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
