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
  /** From the Agent document. Optional: an Agent need not carry one. */
  description?: string;
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
  avatar?: AgentAvatar;
  reconciliation?: AgentReconciliation;
}

/**
 * One observation. `unknown` means this deployment cannot see the signal and `detail` says why — it is never a stand-in for a failure, and no signal is ever invented. `detail` is required because a state with no explanation is not diagnosable.
 */

export interface Signal {
  state: "ok" | "pending" | "degraded" | "unknown";
  detail: string;
}

/**
 * Git desired state joined to actual state, kept separate on purpose. Merged-but-not-synced, synced-but-not-ready and ready-but-not-routable are four different problems with four different fixes.
 */

export interface AgentReconciliation {
  /** The Agent lifecycle: draft → pending-merge → reconciling → active, with degraded and failed as the branches where actual or desired state is broken, and active → reconciling → disabled when an Agent is turned off. `draft` is desired state like any other: the Agent document is merged, but its own lifecycle says it is not meant to run yet. It is deliberately distinct from `disabled`, where something WAS turned off and an operator might go looking for what broke. `pending-merge` is never served by the RUNTIME, which reads the repository as Argo synced it and so cannot see an unmerged branch. It is contributed by the management plane, which holds the Git credential and asks the provider for open proposals. */
  status: "draft" | "pending-merge" | "reconciling" | "active" | "disabled" | "degraded" | "failed";
  git: Signal;
  argo: Signal;
  runtime: Signal;
  manager: Signal;
}

/**
 * Presentation only. `asset` is a path inside the configuration repository, never a URL, and the image is served by the runtime from Git. An Agent without one renders as initials.
 */

export interface AgentAvatar {
  asset: string;
  fit: "cover" | "contain";
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
  avatar?: AgentAvatar;
  promptFile: string;
  /** The system prompt body the runtime loaded */
  prompt: string;
  requiredRoles: Array<string>;
  crossDomainAllowed: Array<string>;
  limits: Record<string, number>;
  access: Array<McpAccessView>;
  identity: AgentIdentityView;
  reconciliation?: AgentReconciliation;
}

/**
 * The unsaved form, as the operator currently has it. Only these fields are read; anything else in the body is discarded by the projection.
 */

export interface PromptAssistRequest {
  name: string;
  displayName?: string;
  description?: string;
  owner?: string;
  routing?: AgentDraftRouting;
  crossDomainAllowed?: Array<string>;
  environments?: Array<string>;
  requiredRoles?: Array<string>;
  access?: Array<AgentDraftAccess>;
  limits?: Record<string, number>;
  /** The current prompt */
  prompt?: string;
}

/**
 * The Manager. Deliberately NOT an AgentDetail: it has no workloadClientId, no access and no routing vocabulary, because it calls no tool. Like AgentDetail, it carries everything needed to rebuild a ManagerDraft, so editing cannot silently delete a field the console never displayed.
 */

export interface ManagerDetail {
  id: string;
  displayName?: string;
  description?: string;
  owner: string;
  lifecycle: AgentLifecycle;
  modelProfile: string;
  modelTier: string;
  promptFile: string;
  prompt: string;
  /** The routing table, DERIVED: every Agent whose own document is active and whose deployment overlay enables it in this environment. It is the same set the orchestrator offers the Manager. There is no authored allowlist any more — onboarding an Agent required a second pull request against one, and nothing checked that anyone did it. */
  routable: Array<string>;
  /** Specialists that exist but are not routable. Listed rather than omitted, so "not shown" and "not reachable" cannot look alike. */
  notRouted: Array<string>;
  /** The deployment environment this runtime serves; `routable` is relative to it. */
  environment: string;
  execution: Record<string, number>;
  /** Stated, so the console shows no blank where a client id would be. */
  identity: {
    provider: "none";
    reason: string;
  };
}

/**
 * What the portal collects to update the Manager. `maxRounds` is absent by design: a second Manager loop is a runtime feature, never configuration, and the schema pins it to 1. A routing table is absent for a different reason: routing is derived from the effective catalog, so no edit here can make an Agent reachable or unreachable.
 */

export interface ManagerDraft {
  modelProfile: string;
  prompt: string;
  owner?: string;
  displayName?: string;
  description?: string;
  lifecycle?: AgentLifecycle;
  promptFile?: string;
  execution?: {
    maxAgentsPerRequest?: number;
    timeoutMs?: number;
  };
}

export interface AgentHealth {
  agentId: string;
  lifecycle: AgentLifecycle;
  /** In the effective catalog — the set the orchestrator routes from. */
  routable: boolean;
  /** `unknown` when no probe is configured. It is never reported as `ready` without something having answered. */
  reachability: "ready" | "unavailable" | "unknown";
  reason: string;
  reconciliation: AgentReconciliation;
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
  /** The question after redaction */
  question?: string;
  /** Hashed initiator; a raw subject never leaves the runtime. */
  userSubjectHash: string;
  agents: Array<string>;
  toolCalls: number;
  evidenceCount: number;
}

/**
 * One event in a run's execution trace. Events record intent (tool.request), enforcement (authorization.check) and execution (toolhive.call) as separate nodes, so a refused attempt is distinguishable from one that was never made.
 */

export interface RunNode {
  id: string;
  /** The trailing values name capabilities the platform does not have yet; they are declared so adding one is an emission rather than a contract change. */
  kind: "user.request" | "manager.route" | "followup.route" | "run.completed" | "specialist" | "agent.action" | "agent.result" | "domain.escalation" | "authorization.check" | "workload.token" | "tool.request" | "toolhive.call" | "evidence" | "synthesis" | "error" | "approval.requested" | "approval.granted" | "write.action" | "retry" | "verify.result";
  label: string;
  parentId?: string;
  status: "ok" | "denied" | "failed" | "timeout";
  startedAt: string;
  durationMs: number;
  actor: "user" | "manager" | "specialist" | "runtime";
  /** The substance of the step - a task */
  detail?: string;
  agentId?: string;
  mcp?: string;
  tool?: string;
  /** Which bounded round produced this node. */
  round?: number;
  /** Event-specific facts. Scalars only, so no payload can be carried here. */
  metadata?: Record<string, string | number | boolean>;
}

export interface RunDetail {
  requestId: string;
  startedAt: string;
  durationMs: number;
  status: "complete" | "partial" | "failed";
  /** The question after redaction */
  question?: string;
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

/**
 * What the Manager reads to decide, semantically, whether this specialist should handle a request. It is description, not a lexicon: no code matches these strings against a question.
 */

export interface AgentDraftRouting {
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
  /** Omitted leaves the current avatar alone, null removes it, an object sets it — either to an asset already in the repository or to a new upload whose bytes join the same change-set. */
  avatar?: {
    asset?: string;
    /** base64 image bytes */
    upload?: string;
    fit?: "cover" | "contain";
  } | null;
}

export interface DiffLine {
  kind: "context" | "add" | "remove";
  /** Line number in the file before the change; absent on an addition. */
  before?: number;
  /** Line number in the file after the change; absent on a removal. */
  after?: number;
  text: string;
}

export interface DiffHunk {
  beforeStart: number;
  beforeLines: number;
  afterStart: number;
  afterLines: number;
  /** Git-style @@ -a,b +c,d @@. */
  header: string;
  lines: Array<DiffLine>;
}

/**
 * One file in a change-set, compared against what is currently on disk. Computed by the runtime, which is the only process that can see the working tree; the portal renders it and computes nothing.
 */

export interface FileDiff {
  path: string;
  status: "added" | "modified" | "deleted" | "unchanged";
  additions: number;
  deletions: number;
  hunks: Array<DiffHunk>;
  /** No line diff is meaningful; the file is still part of the change. */
  binary: boolean;
}

export interface ChangeSetDiff {
  files: Array<FileDiff>;
  additions: number;
  deletions: number;
  /** Files that actually changed; an unchanged file is listed but not counted. */
  changed: number;
}

export interface ChangedFile {
  path: string;
  contents: string;
  /** Present when contents carries bytes rather than text. */
  encoding?: "base64";
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
  diff?: ChangeSetDiff;
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
