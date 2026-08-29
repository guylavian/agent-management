import type { Principal, ToolCredential } from "../agent/principal.ts";

/**
 * The ToolProvider port — how the engine reaches tools, without knowing what is
 * on the other side.
 *
 * There is no protocol named here, no gateway and no transport. A host adapts
 * whatever it runs — a gateway, a direct client, an in-memory fixture — to these
 * two methods at the composition root.
 *
 * `listTools` is authenticated in the same way as `invoke`, because discovery
 * leaks the tool surface just as an invocation does.
 */

export interface ToolDescriptor {
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface ToolCallRequest {
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  environment: string;
  requestId: string;
  principal: Principal;
  /** verified delegated credential the provider checks itself */
  credential?: ToolCredential;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ToolCallResult {
  content: unknown;
  isError?: boolean;
  observedAt: string;
}

export interface ListToolsOptions {
  credential?: ToolCredential;
  requestId?: string;
  signal?: AbortSignal;
}

export interface ToolProvider {
  listTools(serverId: string, principal: Principal, environment: string, options?: ListToolsOptions): Promise<ToolDescriptor[]>;
  invoke(call: ToolCallRequest): Promise<ToolCallResult>;
}

/**
 * A tool the host has APPROVED for use, independent of any Agent. Approval is a
 * property of the tool; whether a given Agent may call it is decided separately
 * by the Agent's own access policy.
 */
export interface ApprovedTool {
  serverId: string;
  toolName: string;
  /** fail closed: an unverified tool is never visible, whatever else allows it */
  readOnlyVerified: boolean;
  environments: string[];
  timeoutMs: number;
  retryPolicy: "none" | "transient-once";
  evidenceKind: "telemetry" | "config" | "wiki";
}

export interface ToolPolicy {
  tools: ApprovedTool[];
}

/** An approved tool paired with the schema the server actually published. */
export interface VisibleTool {
  approved: ApprovedTool;
  schema: ToolDescriptor;
}
