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
  /** 1-based attempt number; 1 for the initial call, 2+ for retries */
  attempt: number;
  /** stable identifier across retry attempts; sha256-32 of requestId+serverId+toolName+canonical args */
  idempotencyKey: string;
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
  /**
   * Execute a tool call. The engine authorizes the tool identity (whether a call to
   * this tool is allowed); the provider MUST enforce resource-level authorization
   * of the argument VALUES under the delegated credential. For example, if
   * arguments contain a resource ID or name, the provider must verify that the
   * credential holder has permission to access that specific resource.
   */
  invoke(call: ToolCallRequest): Promise<ToolCallResult>;
}

/**
 * A tool the host has APPROVED for use, independent of any Agent. Approval is a
 * property of the tool; whether a given Agent may call it is decided separately
 * by the Agent's own access policy.
 *
 * The engine authorizes the tool identity; the ToolProvider implementation MUST
 * enforce resource-level authorization of argument VALUES under the delegated
 * credential. Approval means the tool is available; access to resources named
 * within argument values is decided by the provider.
 */
export interface ApprovedTool {
  serverId: string;
  toolName: string;
  /** fail closed: an unverified tool is never visible, whatever else allows it */
  readOnlyVerified: boolean;
  environments: string[];
  timeoutMs: number;
  retryPolicy: "none" | "transient-once";
  /** OPEN taxonomy: copied verbatim onto the evidence this tool produces; a host narrows it in its own catalog schema */
  evidenceKind: string;
  /** true when the tool returns versioned documents: evidence records sourceModifiedAt (document version) instead of observedAt (live observation) */
  sourceVersioned?: boolean;
  /** pinned copy used exclusively when present; live drift → tool.schema.drift counter */
  pinnedDescription?: string;
  /** pinned copy used exclusively when present; oversized live schema → tool excluded */
  pinnedInputSchema?: Record<string, unknown>;
}

export interface ToolPolicy {
  tools: ApprovedTool[];
}

/** An approved tool paired with the schema the server actually published. */
export interface VisibleTool {
  approved: ApprovedTool;
  schema: ToolDescriptor;
}
