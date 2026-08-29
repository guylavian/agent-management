import type {
  AgentDetail,
  AgentSummary,
  ChangePreview,
  McpAccessView as ContractMcpAccessView,
  McpServer,
  PermissionMatrix,
  RunDetail,
  RunSummary as ContractRunSummary,
  ToolView as ContractToolView,
} from "@sre/management-api-contract";
import type { AgentDetailView, AgentSummaryView, McpAccessView, McpServerView, ToolView } from "./view-model.ts";
import type { RunRecord, RunSummary } from "./run-store.ts";
import type { GeneratedChange, ProposedChange } from "./yaml.ts";

/**
 * COMPILE-TIME CONFORMANCE.
 *
 * contracts/management-api/openapi.yaml is the neutral contract; these
 * assignments make the compiler prove that what the runtime actually returns
 * satisfies it. Without them the OpenAPI document would be documentation, and
 * documentation drifts — which is exactly what happened when the runtime and
 * the portal each hand-declared these twenty shapes.
 *
 * Nothing here runs. If a projection changes shape, `npm run typecheck` fails
 * and the contract must be updated deliberately.
 */
type Conforms<Actual extends Contract, Contract> = Actual;

export type _ToolView = Conforms<ToolView, ContractToolView>;
export type _McpAccessView = Conforms<McpAccessView, ContractMcpAccessView>;
export type _AgentSummary = Conforms<AgentSummaryView, AgentSummary>;
export type _AgentDetail = Conforms<AgentDetailView, AgentDetail>;
export type _McpServer = Conforms<McpServerView, McpServer>;
export type _RunSummary = Conforms<RunSummary, ContractRunSummary>;
export type _RunDetail = Conforms<RunRecord, RunDetail>;

/** The preview response is assembled from the generated change plus the proposal. */
export type _ChangePreview = Conforms<
  {
    path: GeneratedChange["path"];
    yaml: GeneratedChange["yaml"];
    files: GeneratedChange["files"];
    branch: ProposedChange["branch"];
    title: ProposedChange["title"];
    body: ProposedChange["body"];
    effects: ProposedChange["effects"];
  },
  ChangePreview
>;

export type { PermissionMatrix };
