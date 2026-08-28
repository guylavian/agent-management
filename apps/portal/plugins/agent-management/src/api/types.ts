/**
 * Wire types for the agent-management backend.
 *
 * These mirror the projections the runtime's management API returns. The
 * canonical Agent schema deliberately lives in the runtime (@sre/agent-schema);
 * the portal consumes its projections rather than re-declaring the model, so
 * there is no second Agent definition to drift.
 */

export type ToolClassification = 'read' | 'write' | 'unknown';
export type AgentLifecycle = 'draft' | 'active' | 'disabled' | 'decommissioning' | 'removed';

export interface ToolView {
  name: string;
  classification: ToolClassification;
  role?: string;
}

export interface McpAccessView {
  mcp: string;
  allowed: boolean;
  audience?: string;
  audienceScope?: string;
  allowedTools: ToolView[];
  blockedTools: ToolView[];
}

export interface AgentSummary {
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

export interface AgentDetail extends AgentSummary {
  promptFile: string;
  requiredRoles: string[];
  crossDomainAllowed: string[];
  limits: Record<string, number>;
  access: McpAccessView[];
  identity: { provider: string; clientId: string; authentication: string; tokenPolicy: string };
}

export interface McpServer {
  id: string;
  toolCount: number;
  tools: ToolView[];
  agents: string[];
  expectedAudience: string;
  audienceScope: string;
  readOnlyVerified: boolean;
  toolhiveEndpoint?: string;
}

export interface PermissionCell {
  agent: string;
  mcp: string;
  allowed: boolean;
  toolCount: number;
}

export interface PermissionMatrix {
  mcps: string[];
  rows: Array<{ agent: string; cells: PermissionCell[] }>;
}

export interface RunSummary {
  requestId: string;
  startedAt: string;
  durationMs: number;
  status: 'complete' | 'partial' | 'failed';
  userSubjectHash: string;
  agents: string[];
  toolCalls: number;
  evidenceCount: number;
}

export interface RunNode {
  id: string;
  kind: string;
  label: string;
  parentId?: string;
  status: 'ok' | 'denied' | 'failed' | 'timeout';
  startedAt: string;
  durationMs: number;
  agentId?: string;
  mcp?: string;
  tool?: string;
  round?: number;
}

export interface RunDetail extends RunSummary {
  environment: string;
  workloads: string[];
  deniedToolCalls: number;
  modelProfiles: string[];
  nodes: RunNode[];
}

export interface AgentDraft {
  name: string;
  owner: string;
  displayName?: string;
  modelTier: 'small' | 'large';
  modelProfile: string;
  requiredRoles: string[];
  crossDomainAllowed?: string[];
  access: Array<{ mcp: string; tools: string[] }>;
}

export interface ChangePreview {
  path: string;
  yaml: string;
  branch: string;
  title: string;
  effects: string[];
}

/** Endpoints answer this shape when the deployment has no backend wired. */
export interface NotConfigured {
  status: 'not-configured';
  reason: string;
}

export function isNotConfigured(value: unknown): value is NotConfigured {
  return typeof value === 'object' && value !== null && (value as NotConfigured).status === 'not-configured';
}
