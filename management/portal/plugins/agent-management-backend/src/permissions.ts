import { createPermission } from '@backstage/plugin-permission-common';

/**
 * Management-plane permissions (TDD §40).
 *
 * These govern WHO MAY MANAGE an Agent. They are a completely different
 * authorization domain from Agent → MCP → Tool: holding `agent.access.edit`
 * lets a human propose a policy change, it never grants an Agent access to
 * anything. The runtime remains the only authority for what an Agent may call.
 */

export const agentReadPermission = createPermission({ name: 'agent.read', attributes: { action: 'read' } });
export const agentCreatePermission = createPermission({ name: 'agent.create', attributes: { action: 'create' } });
export const agentEditPermission = createPermission({ name: 'agent.edit', attributes: { action: 'update' } });
export const agentDisablePermission = createPermission({ name: 'agent.disable', attributes: { action: 'update' } });
export const agentPromptEditPermission = createPermission({ name: 'agent.prompt.edit', attributes: { action: 'update' } });
export const agentAccessEditPermission = createPermission({ name: 'agent.access.edit', attributes: { action: 'update' } });
export const agentToolsEditPermission = createPermission({ name: 'agent.tools.edit', attributes: { action: 'update' } });
export const agentCreatePrPermission = createPermission({ name: 'agent.gitops.createPr', attributes: { action: 'create' } });
export const mcpReadPermission = createPermission({ name: 'mcp.read', attributes: { action: 'read' } });
export const runReadPermission = createPermission({ name: 'run.read', attributes: { action: 'read' } });
export const evaluationReadPermission = createPermission({ name: 'evaluation.read', attributes: { action: 'read' } });

export const agentManagementPermissions = [
  agentReadPermission,
  agentCreatePermission,
  agentEditPermission,
  agentDisablePermission,
  agentPromptEditPermission,
  agentAccessEditPermission,
  agentToolsEditPermission,
  agentCreatePrPermission,
  mcpReadPermission,
  runReadPermission,
  evaluationReadPermission,
];
