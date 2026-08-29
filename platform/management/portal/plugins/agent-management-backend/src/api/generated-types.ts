/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Produced by `npm run gen:management-api` from platform/contracts/management-api/openapi.yaml
 * (version 0.1.0). CI re-generates and fails on any diff, so an
 * edit here is lost rather than applied — change the OpenAPI document instead.
 */

/**
 * A tool absent from the approved catalog is `unknown`, never `read`.
 */

export type ToolClassification = "read" | "write" | "unknown";

export type AgentLifecycle = "draft" | "active" | "disabled" | "decommissioning" | "removed";

export interface ToolView {
  name: string;
  classification: ToolClassification;
  /** Keycloak client role representing this grant, when granted. */
  role?: string;
}

export interface McpAccessView {
  mcp: string;
  allowed: boolean;
  audience?: string;
  audienceScope?: string;
  allowedTools: Array<ToolView>;
  /** Approved-catalog tools on this MCP the Agent is NOT granted. */
  blockedTools: Array<ToolView>;
}

export interface AgentSummary {
  id: string;
  displayName: string;
  owner: string;
  lifecycle: AgentLifecycle;
  enabled: boolean;
  /** Logical profile; the environment binds it to a served model. */
  modelProfile: string;
  modelTier: string;
  mcpCount: number;
  toolCount: number;
  /** Derived, never author-supplied. */
  workloadClientId: string;
  readOnly: boolean;
}

export interface AgentIdentityView {
  provider: string;
  clientId: string;
  authentication: string;
  tokenPolicy: string;
}

/**
 * Everything the console shows about one Agent. It is also everything the portal needs to REBUILD the Agent's document, because editing an Agent regenerates that document from this view — so a field missing here is a field an edit deletes. A round-trip test asserts the equality.
 */

export interface AgentDetail {
  id: string;
  displayName: string;
  description?: string;
  owner: string;
  lifecycle: AgentLifecycle;
  environments: Array<string>;
  routing: AgentDraftRouting;
  enabled: boolean;
  modelProfile: string;
  modelTier: string;
  mcpCount: number;
  toolCount: number;
  workloadClientId: string;
  readOnly: boolean;
  promptFile: string;
  /** The system prompt body the runtime loaded */
  prompt: string;
  requiredRoles: Array<string>;
  crossDomainAllowed: Array<string>;
  limits: Record<string, number>;
  access: Array<McpAccessView>;
  identity: AgentIdentityView;
}

export interface AgentHealth {
  agentId: string;
  lifecycle: AgentLifecycle;
  routable: boolean;
  reachability: "unknown";
  reason: string;
}

export interface AgentMetrics {
  agentId: string;
  source: string;
  requestCount: number;
  successRate: number;
  p95LatencyMs?: number;
  lastActivity?: string;
}

export interface McpServer {
  id: string;
  toolCount: number;
  tools: Array<ToolView>;
  /** Agents whose canonical policy grants them this MCP. */
  agents: Array<string>;
  expectedAudience: string;
  audienceScope: string;
  /** True only when every approved tool on the server is read-only-verified. */
  readOnlyVerified: boolean;
  toolhiveEndpoint?: string;
}

export interface PermissionCell {
  agent: string;
  mcp: string;
  allowed: boolean;
  toolCount: number;
}

export interface PermissionRow {
  agent: string;
  cells: Array<PermissionCell>;
}

export interface PermissionMatrix {
  mcps: Array<string>;
  rows: Array<PermissionRow>;
}

export interface RunSummary {
  requestId: string;
  startedAt: string;
  durationMs: number;
  status: "complete" | "partial" | "failed";
  /** Hashed initiator; a raw subject never leaves the runtime. */
  userSubjectHash: string;
  agents: Array<string>;
  toolCalls: number;
  evidenceCount: number;
}

export interface RunNode {
  id: string;
  kind: "manager.route" | "specialist" | "authorization.check" | "workload.token" | "tool.request" | "toolhive.call" | "evidence" | "domain.escalation" | "synthesis";
  label: string;
  parentId?: string;
  status: "ok" | "denied" | "failed" | "timeout";
  startedAt: string;
  durationMs: number;
  agentId?: string;
  mcp?: string;
  tool?: string;
  /** Which bounded round produced this node. */
  round?: number;
}

export interface RunDetail {
  requestId: string;
  startedAt: string;
  durationMs: number;
  status: "complete" | "partial" | "failed";
  userSubjectHash: string;
  environment: string;
  agents: Array<string>;
  /** Workload client ids that actually executed. */
  workloads: Array<string>;
  toolCalls: number;
  deniedToolCalls: number;
  evidenceCount: number;
  modelProfiles: Array<string>;
  nodes: Array<RunNode>;
}

export interface AgentDraftAccess {
  mcp: string;
  tools: Array<string>;
}

export interface AgentDraftRouting {
  exactTerms?: Array<string>;
  entityPatterns?: Array<string>;
  ambiguousTerms?: Array<string>;
  capabilities?: Array<string>;
  exclusions?: Array<string>;
}

/**
 * What the portal collects to create or update an Agent. The workload client id and every ToolHive audience are DERIVED from the name, never supplied, so the portal cannot grant an Agent another Agent's identity.
 */

export interface AgentDraft {
  name: string;
  owner: string;
  displayName?: string;
  description?: string;
  lifecycle?: AgentLifecycle;
  modelTier: "small" | "large";
  modelProfile: string;
  promptFile?: string;
  /** The system prompt body; persisted to config/prompts/<name>.md. */
  prompt?: string;
  environments?: Array<string>;
  routing?: AgentDraftRouting;
  requiredRoles: Array<string>;
  crossDomainAllowed?: Array<string>;
  access: Array<AgentDraftAccess>;
  limits?: Record<string, number>;
}

export interface ChangedFile {
  path: string;
  contents: string;
}

export interface ChangePreview {
  /** Path of the canonical Agent document. */
  path: string;
  yaml: string;
  branch: string;
  title: string;
  /** Pull-request description, rendered by the runtime for the management plane to publish. */
  body: string;
  effects: Array<string>;
  /** Every file in the change-set — Agent, prompt and deployment overlay. */
  files: Array<ChangedFile>;
}

/**
 * Outcome of publishing a change-set. Produced by the MANAGEMENT plane, which owns the Git credential; the runtime never returns one.
 */

export interface ChangeResult {
  status: "created" | "not-configured";
  url?: string;
  reason?: string;
  branch: string;
  effects: Array<string>;
}

/**
 * Answered when a deployment has no backend wired, instead of inventing numbers.
 */

export interface NotConfigured {
  status: "not-configured";
  reason: string;
}

export interface ApiError {
  code: string;
  message: string;
  requestId?: string;
}

export interface DraftError {
  code: "AGENT_DRAFT_INVALID";
  message: string;
  issues: Array<string>;
}

/** Endpoints answer this shape when the deployment has no backend wired. */
export function isNotConfigured(value: unknown): value is NotConfigured {
  return typeof value === "object" && value !== null && (value as NotConfigured).status === "not-configured";
}
