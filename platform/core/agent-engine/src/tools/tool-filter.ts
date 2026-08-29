import { AuthorizationService, type RequestIdentity, type ToolCredential } from "@sre/auth";
import { accessServers, type AgentRegistry, type ApprovedCatalog, type ApprovedTool, type SpecialistAgentConfig } from "@sre/config";
import type { McpTool, ToolHiveClient, ToolInvocation, ToolResult } from "./toolhive-client.ts";

export interface VisibleTool { approved: ApprovedTool; schema: McpTool }

export async function visibleTools(
  registry: AgentRegistry,
  authorization: AuthorizationService,
  toolhive: ToolHiveClient,
  agentId: string,
  identity: RequestIdentity,
  environment: string,
): Promise<VisibleTool[]> {
  const agent = registry.getSpecialist(agentId);
  if (agent === undefined) return [];
  return visibleToolsForSpecialist(registry.catalog, authorization, toolhive, agent, identity, environment);
}

export async function visibleToolsForSpecialist(
  catalog: ApprovedCatalog,
  authorization: AuthorizationService,
  toolhive: ToolHiveClient,
  agent: SpecialistAgentConfig,
  identity: RequestIdentity,
  environment: string,
  credentials: ReadonlyMap<string, ToolCredential> = new Map(),
  signal?: AbortSignal,
): Promise<VisibleTool[]> {
  const discovered = await Promise.allSettled(accessServers(agent.spec).map((server) => toolhive.listTools(server, identity, environment, { credential: credentials.get(server), requestId: identity.requestId, ...(signal ? { signal } : {}) })));
  const gatewayTools = discovered.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const gatewayByKey = new Map(gatewayTools.map((tool) => [`${tool.serverId}:${tool.name}`, tool]));
  return catalog.tools.flatMap((approved) => {
    const schema = gatewayByKey.get(`${approved.serverId}:${approved.toolName}`);
    return schema !== undefined && isReadOnlyTool(schema) && authorization.preflightTool(identity, agent, approved, environment).allowed ? [{ approved, schema }] : [];
  });
}

export async function invokeVisibleToolForSpecialist(
  catalog: ApprovedCatalog,
  authorization: AuthorizationService,
  toolhive: ToolHiveClient,
  agent: SpecialistAgentConfig,
  invocation: ToolInvocation,
): Promise<ToolResult> {
  const credentials = new Map(invocation.credential ? [[invocation.serverId, invocation.credential]] : []);
  // audience → resource binding is checked before the call, so a credential minted
  // for another ToolHive resource is rejected by the runtime and never presented
  if (invocation.credential !== undefined && !authorization.authorizeAudience(agent, invocation.serverId, invocation.credential.audience).allowed) {
    throw Object.assign(new Error("Tool access denied"), { code: "TOOL_DENIED" });
  }
  const allowed = await visibleToolsForSpecialist(catalog, authorization, toolhive, agent, invocation.identity, invocation.environment, credentials, invocation.signal);
  if (!allowed.some(({ approved }) => approved.serverId === invocation.serverId && approved.toolName === invocation.toolName)) {
    throw Object.assign(new Error("Tool access denied"), { code: "TOOL_DENIED" });
  }
  return toolhive.invoke(invocation);
}

const MUTATION_NAME = /(?:^|_)(?:create|update|delete|remove|write|set|put|patch|sync|apply|assign|unassign|propose|render|reload|quit|snapshot|clean)(?:_|$)/iu;

/** Runtime backstop in addition to the approved catalog and ToolHive allow-list. */
export function isReadOnlyTool(tool: McpTool): boolean {
  return tool.annotations?.destructiveHint !== true && !MUTATION_NAME.test(tool.name);
}

export async function invokeVisibleTool(
  registry: AgentRegistry,
  authorization: AuthorizationService,
  toolhive: ToolHiveClient,
  agentId: string,
  invocation: ToolInvocation,
): Promise<ToolResult> {
  const allowed = await visibleTools(registry, authorization, toolhive, agentId, invocation.identity, invocation.environment);
  if (!allowed.some(({ approved }) => approved.serverId === invocation.serverId && approved.toolName === invocation.toolName)) {
    throw Object.assign(new Error("Tool access denied"), { code: "TOOL_DENIED" });
  }
  return toolhive.invoke(invocation);
}
