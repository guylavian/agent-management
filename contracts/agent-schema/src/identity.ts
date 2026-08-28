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

/**
 * Keycloak client scope that mints one MCP audience. Kebab-cased because
 * Keycloak scope names cannot contain ':'.
 *
 * This lives with the other canonical derivations rather than in the
 * provisioner: the management API needs to display it, and pulling the
 * provisioner (which carries the Keycloak Admin API client) into anything the
 * runtime hosts would couple request handling to the Admin API — TDD §31.
 */
export function audienceScopeName(mcp: string): string {
  return `sre-toolhive-${mcp}`;
}

/** Client role representing one Agent → MCP → Tool grant — TDD §10. */
export function toolRoleName(mcp: string, tool: string): string {
  return `${mcp}:${tool}`;
}
