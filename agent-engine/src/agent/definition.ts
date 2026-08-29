/**
 * What the engine needs to know about an Agent — and deliberately nothing more.
 *
 * This is the engine's OWN vocabulary. It is not the host's Agent
 * document, and it has no `spec`, no `lifecycle` enum, no owner, no routing and
 * no capabilities: the engine cannot route, so it must not be able to read
 * routing. A host maps its own configuration onto this shape at the composition
 * root, which is the only place that knows both.
 *
 * Every field here is something the bounded loop actually consults. If a field
 * stops being read, it stops belonging.
 */

/** Every budget the loop enforces. All are required: an absent budget is unbounded. */
export interface AgentBudgets {
  maxToolCalls: number;
  maxModelTurns: number;
  timeoutMs: number;
  maxEvidenceBytes: number;
  maxContextTokens: number;
  maxEvidenceItems: number;
  maxRawExcerptBytes: number;
}

/** One tool server this Agent may reach, and exactly which tools on it. */
export interface AgentToolAccess {
  server: string;
  /** exact tool names; there is no wildcard, by design */
  tools: string[];
  /** credential audience this server's calls must be bound to, when credentials are in use */
  audience?: string;
}

/**
 * The Agent's own workload identity, distinct from the delegated human. Opaque
 * to the engine: it is passed to the CredentialProvider and named in telemetry,
 * never interpreted. Absent when the host mints no workload credentials.
 */
export interface AgentWorkload {
  clientId: string;
  provider: string;
}

export interface AgentDefinition {
  id: string;
  systemPrompt: string;
  /** logical model profile, resolved to a served model by the host's Model */
  modelProfile: string;
  budgets: AgentBudgets;
  access: AgentToolAccess[];
  /** a disabled Agent is denied execution, whatever the caller's roles */
  enabled: boolean;
  /** roles the delegated principal must hold to use this Agent at all */
  requiredRoles: string[];
  /** Phase 1 posture: false denies every tool call, regardless of the catalog */
  readOnly: boolean;
  workload?: AgentWorkload;
  /** opaque label recorded on the authorization span; never a decision input */
  lifecycleLabel?: string;
}

export function accessServers(agent: AgentDefinition): string[] {
  return agent.access.map((entry) => entry.server);
}

/** Exact per-server tool grant. A tool granted on one server is not granted on another. */
export function isToolAllowed(agent: AgentDefinition, server: string, toolName: string): boolean {
  const entry = agent.access.find((item) => item.server === server);
  return entry !== undefined && entry.tools.includes(toolName);
}

/** Audience the credential for this Agent → server call must carry, or undefined when the server is not in policy. */
export function audienceFor(agent: AgentDefinition, server: string): string | undefined {
  return agent.access.find((item) => item.server === server)?.audience;
}
