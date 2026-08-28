/**
 * Canonical derivations shared by the runtime, the management plane, Keycloak
 * provisioning and ToolHive. They are pure functions of the Agent name / MCP
 * server id so no component can drift from another.
 */

/** Workload (client) identity of one Agent — TDD §7. Never a shared credential. */
export function workloadClientId(agentName: string): string {
  return `sre-agent-${agentName}`;
}

/** ToolHive audience for one MCP server; a credential is scoped to exactly this value — TDD §9. */
export function toolHiveAudience(serverId: string): string {
  return `sre-toolhive:${serverId}`;
}
