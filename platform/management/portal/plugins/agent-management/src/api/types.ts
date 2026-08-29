/**
 * Wire types for the agent-management backend.
 *
 * These are GENERATED from `contracts/management-api/openapi.yaml` — the same
 * document the runtime implements against. The portal used to hand-declare them
 * and drift silently; now there is one contract and two generated copies, and
 * CI fails on any difference between them.
 *
 * The canonical Agent schema still lives in the runtime (@sre/agent-schema).
 * The portal consumes PROJECTIONS of it, never the model itself, so there is no
 * second Agent definition anywhere. It also imports no TypeScript source across
 * the npm ↔ Yarn workspace boundary: the generated file is checked in here.
 *
 * This module is the portal's stable import surface; it re-exports rather than
 * re-declares, so component imports do not change when the contract does.
 */
export type {
  AgentDetail,
  AgentDraft,
  AgentDraftAccess,
  AgentDraftRouting,
  AgentHealth,
  AgentIdentityView,
  AgentLifecycle,
  AgentMetrics,
  AgentSummary,
  ApiError,
  ChangePreview,
  ChangeResult,
  ChangedFile,
  DraftError,
  ManagerDetail,
  ManagerDraft,
  McpAccessView,
  McpServer,
  NotConfigured,
  PermissionCell,
  PermissionMatrix,
  PermissionRow,
  RunDetail,
  RunNode,
  RunSummary,
  ToolClassification,
  ToolView,
} from './generated-types';

export { isNotConfigured } from './generated-types';
