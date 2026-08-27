import { AuthorizationService, type RequestIdentity } from "@sre/auth";
import type { AgentRegistry, ApprovedCatalog, ApprovedTool, SpecialistAgentConfig } from "@sre/config";
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
): Promise<VisibleTool[]> {
  const discovered = await Promise.allSettled(agent.spec.mcp.servers.map((server) => toolhive.listTools(server, identity, environment)));
  const gatewayTools = discovered.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const gatewayByKey = new Map(gatewayTools.map((tool) => [`${tool.serverId}:${tool.name}`, tool]));
  return catalog.tools.flatMap((approved) => {
    const schema = gatewayByKey.get(`${approved.serverId}:${approved.toolName}`);
    return schema !== undefined && authorization.preflightTool(identity, agent, approved, environment).allowed ? [{ approved, schema }] : [];
  });
}

export async function invokeVisibleToolForSpecialist(
  catalog: ApprovedCatalog,
  authorization: AuthorizationService,
  toolhive: ToolHiveClient,
  agent: SpecialistAgentConfig,
  invocation: ToolInvocation,
): Promise<ToolResult> {
  const allowed = await visibleToolsForSpecialist(catalog, authorization, toolhive, agent, invocation.identity, invocation.environment);
  if (!allowed.some(({ approved }) => approved.serverId === invocation.serverId && approved.toolName === invocation.toolName)) {
    throw Object.assign(new Error("Tool access denied"), { code: "TOOL_DENIED" });
  }
  return toolhive.invoke(invocation);
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
