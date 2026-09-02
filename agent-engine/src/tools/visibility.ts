import { accessServers, type AgentDefinition } from "../agent/definition.ts";
import type { Principal, ToolCredential } from "../agent/principal.ts";
import { authorizeAudience, authorizeTool } from "../guardrails/authorization.ts";
import { isReadOnlyTool } from "../guardrails/read-only.ts";
import { engineError } from "../errors/index.ts";
import type { ToolCallRequest, ToolCallResult, ToolDescriptor, ToolPolicy, ToolProvider, VisibleTool } from "./port.ts";

/**
 * What this Agent can see right now:
 *
 *     approved policy ∩ published by the server ∩ read-only ∩ authorized here
 *
 * Every term narrows. A tool the policy approved but the server no longer
 * publishes is invisible; a tool the server publishes but the policy never
 * approved is invisible; and neither the Agent nor the model can widen the set,
 * because the model never sees anything outside it.
 *
 * Discovery uses allSettled: one unreachable server contributes no tools rather
 * than failing the whole investigation. Failures are returned alongside tools
 * so the caller can record them as MCP_UNAVAILABLE errors.
 */
export async function visibleTools(
  agent: AgentDefinition,
  policy: ToolPolicy,
  provider: ToolProvider,
  principal: Principal,
  environment: string,
  credentials: ReadonlyMap<string, ToolCredential> = new Map(),
  signal?: AbortSignal,
): Promise<{ tools: VisibleTool[]; failures: Array<{ server: string; error: unknown }> }> {
  const servers = accessServers(agent);
  const discovered = await Promise.allSettled(servers.map((server) => provider.listTools(server, principal, environment, {
    ...(credentials.get(server) ? { credential: credentials.get(server) as ToolCredential } : {}),
    requestId: principal.requestId,
    ...(signal ? { signal } : {}),
  })));
  const failures: Array<{ server: string; error: unknown }> = [];
  const publishedDescriptors: ToolDescriptor[] = [];
  for (let i = 0; i < discovered.length; i += 1) {
    const result = discovered[i]!;
    const server = servers[i]!;
    if (result.status === "fulfilled") {
      // N17: drop descriptors claiming a different serverId than the server actually queried
      const validDescriptors = result.value.filter((descriptor) => descriptor.serverId === server);
      publishedDescriptors.push(...validDescriptors);
    } else if (result.status === "rejected") {
      failures.push({ server, error: result.reason });
    }
  }
  const published = new Map(publishedDescriptors.map((tool) => [`${tool.serverId}:${tool.name}`, tool]));
  const tools = policy.tools.flatMap((approved) => {
    const schema = published.get(`${approved.serverId}:${approved.toolName}`);
    return schema !== undefined && isReadOnlyTool(schema) && authorizeTool(principal, agent, approved, environment).allowed ? [{ approved, schema }] : [];
  });
  return { tools, failures };
}

/**
 * Invoke a tool only if it is visible AT THE MOMENT OF THE CALL.
 *
 * Visibility is recomputed here rather than trusted from the loop's cached set,
 * so an Agent disabled or a tool withdrawn mid-investigation stops the very next
 * call. The audience binding is checked first, before the credential is
 * presented anywhere: a credential minted for another resource is rejected by
 * this runtime and never leaves it.
 */
export async function invokeVisibleTool(
  agent: AgentDefinition,
  policy: ToolPolicy,
  provider: ToolProvider,
  call: ToolCallRequest,
): Promise<ToolCallResult> {
  if (call.credential !== undefined && !authorizeAudience(agent, call.serverId, call.credential.audience).allowed) {
    throw engineError("TOOL_DENIED", "Tool access denied");
  }
  const credentials = new Map(call.credential ? [[call.serverId, call.credential]] : []);
  const discovered = await visibleTools(agent, policy, provider, call.principal, call.environment, credentials, call.signal);
  if (!discovered.tools.some(({ approved }) => approved.serverId === call.serverId && approved.toolName === call.toolName)) {
    throw engineError("TOOL_DENIED", "Tool access denied");
  }
  return provider.invoke(call);
}
