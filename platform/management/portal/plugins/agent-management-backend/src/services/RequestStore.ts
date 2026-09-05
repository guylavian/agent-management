import { createHash, randomUUID } from 'node:crypto';
import type { AgentReconciliation, AgentSummary, ChangeSetDiff, ManagementRequestDetail, ManagementRequestSummary, RunNode } from '../api/generated-types';
import type { PullRequestState } from './GitOpsPublisher';

/**
 * MANAGEMENT REQUESTS: a platform change, traced like a run.
 *
 *   Run     = execution of a user question   (user → manager → specialist → tool → answer)
 *   Request = execution of a management change (user → portal → PR → merge → Argo → runtime → routable)
 *
 * The store keeps only what THIS plane did and observed: who asked for what,
 * whether the change-set rendered, whether the pull request opened, and the
 * provider's last answer about that pull request. Everything after the merge
 * is read from the runtime's reconciliation on every request and projected
 * onto the same `RunNode` event vocabulary Runs use — so there is no second
 * event log, no stored "status" that can drift from reality, and the console
 * renders both with one Flow and one Timeline.
 *
 * Nothing here is invented: a step that has not happened is emitted as
 * `pending` with the observed reason, and a signal the deployment cannot
 * observe says so rather than turning green.
 *
 * Two implementations. The in-memory one is bounded and loses everything on a
 * backend restart, which is survivable for a console but not for an audit
 * trail. `PostgresRequestStore` persists the record and appends what this plane
 * observed to the shared append-only event log, so a restart costs nothing.
 *
 * The interface is ASYNC because durability is: every call site already sits
 * inside an async handler, so awaiting costs nothing and pretending the write
 * had landed would cost the record.
 */

export type RequestType = ManagementRequestSummary['type'];
export type RequestStatus = ManagementRequestSummary['status'];

export interface RequestRecord {
  id: string;
  agentId: string;
  type: RequestType;
  requestedBy: string;
  createdAt: string;
  branch: string;
  effects: string[];
  /** the rendered configuration diff — YAML, never a credential */
  diff?: ChangeSetDiff;
  preparedAt?: string;
  /** safe message from the runtime's preview; the runtime redacts its own errors */
  prepareError?: string;
  publishedAt?: string;
  publishError?: string;
  /** the deployment has no Git credential wired; the reason is a config hint */
  notConfigured?: string;
  pullRequest?: { number: number; url?: string };
  /** the provider's last answer; terminal states are cached so we stop asking */
  pullRequestState?: PullRequestState & { observedAt: string };
}

export interface RequestStore {
  readonly mode: 'mock' | 'real';
  record(request: RequestRecord): Promise<void>;
  update(id: string, patch: Partial<RequestRecord>): Promise<RequestRecord | undefined>;
  list(): Promise<RequestRecord[]>;
  get(id: string): Promise<RequestRecord | undefined>;
}

export class InMemoryRequestStore implements RequestStore {
  readonly mode = 'mock' as const;
  readonly #capacity: number;
  readonly #requests = new Map<string, RequestRecord>();

  constructor(capacity = 200) {
    if (capacity < 1) throw new Error('request store capacity must be at least 1');
    this.#capacity = capacity;
  }

  async record(request: RequestRecord): Promise<void> {
    this.#requests.delete(request.id);
    this.#requests.set(request.id, request);
    while (this.#requests.size > this.#capacity) {
      const oldest = this.#requests.keys().next();
      if (oldest.done === true) break;
      this.#requests.delete(oldest.value);
    }
  }

  async update(id: string, patch: Partial<RequestRecord>): Promise<RequestRecord | undefined> {
    const current = this.#requests.get(id);
    if (current === undefined) return undefined;
    const next = { ...current, ...patch };
    this.#requests.set(id, next);
    return next;
  }

  async list(): Promise<RequestRecord[]> {
    return [...this.#requests.values()].reverse();
  }

  async get(id: string): Promise<RequestRecord | undefined> {
    return this.#requests.get(id);
  }
}

export function newRequestId(): string {
  return randomUUID();
}

/**
 * What the runtime currently says, as fetched by the caller. `undefined` means
 * the runtime could not be asked — a different fact from "the agent is absent".
 */
export interface RuntimeSnapshot {
  loadedAt: string;
  configError?: string;
  agents: AgentSummary[];
}

export interface ProjectionInput {
  record: RequestRecord;
  /** provider state as of now, or an error message when the provider could not be asked */
  pullRequest?: PullRequestState | { error: string };
  runtime?: RuntimeSnapshot | { error: string };
}

type Status = RunNode['status'];

/** `a` is strictly later than `b`; an unparseable timestamp is never later */
function after(a: string, b: string): boolean {
  const left = Date.parse(a);
  const right = Date.parse(b);
  return Number.isFinite(left) && Number.isFinite(right) && left > right;
}

/**
 * A linear chain of steps. Each step's `parentId` is the previous one, so the
 * Flow view draws the request as the straight line it is and the Timeline
 * orders by the real timestamps.
 */
class Chain {
  readonly nodes: RunNode[] = [];
  #last?: RunNode;
  #lastAt: string;

  constructor(origin: string) {
    this.#lastAt = origin;
  }

  push(node: Omit<RunNode, 'id' | 'parentId' | 'durationMs' | 'startedAt'> & { startedAt?: string }): RunNode {
    const startedAt = node.startedAt ?? this.#lastAt;
    const built: RunNode = {
      ...node,
      id: `${this.nodes.length + 1}-${node.kind}`,
      ...(this.#last ? { parentId: this.#last.id } : {}),
      startedAt,
      durationMs: 0,
    };
    this.nodes.push(built);
    this.#last = built;
    if (after(startedAt, this.#lastAt)) this.#lastAt = startedAt;
    return built;
  }
}

const TYPE_LABEL: Record<RequestType, string> = { create: 'Create', edit: 'Edit', enable: 'Enable', disable: 'Disable', delete: 'Delete' };

/** Terminal Agent statuses that mean "desired state and actual state agree". */
function settled(type: RequestType, agentStatus: AgentReconciliation['status']): boolean {
  if (type === 'enable') return agentStatus === 'active';
  if (type === 'disable') return agentStatus === 'disabled';
  return agentStatus === 'active' || agentStatus === 'disabled' || agentStatus === 'draft';
}

function signalStatus(state: AgentReconciliation['git']['state']): Status {
  if (state === 'ok') return 'ok';
  if (state === 'degraded') return 'failed';
  return 'pending';
}

/**
 * The projection. Pure, so the same inputs always give the same trace and a
 * test can hand it a literal.
 */
export function projectRequest(input: ProjectionInput): ManagementRequestDetail {
  const { record } = input;
  const chain = new Chain(record.createdAt);
  // filled in once the runtime has been consulted; read by `finish`
  const observed: { agentStatus?: AgentReconciliation['status']; reconciliation?: AgentReconciliation } = {};
  let updatedAt = record.createdAt;
  const bump = (at?: string) => { if (at !== undefined && after(at, updatedAt)) updatedAt = at; };

  chain.push({
    kind: 'request.created', actor: 'user', status: 'ok', startedAt: record.createdAt,
    label: `${TYPE_LABEL[record.type]} ${record.agentId}`,
    detail: `requested by ${record.requestedBy}`,
    agentId: record.agentId,
    metadata: { component: 'portal', type: record.type, requestedBy: record.requestedBy },
  });

  const finish = (final: RequestStatus, blocked?: string): ManagementRequestDetail => ({
    id: record.id,
    agentId: record.agentId,
    type: record.type,
    requestedBy: record.requestedBy,
    status: final,
    ...(observed.agentStatus === undefined ? {} : { agentStatus: observed.agentStatus }),
    createdAt: record.createdAt,
    updatedAt,
    branch: record.branch,
    ...(record.pullRequest ? { pullRequest: record.pullRequest } : {}),
    ...(blocked === undefined ? {} : { blockedBy: blocked }),
    effects: record.effects,
    ...(record.diff ? { diff: record.diff } : {}),
    ...(observed.reconciliation ? { reconciliation: observed.reconciliation } : {}),
    nodes: chain.nodes,
  });

  const fail = (detail: string, at?: string): ManagementRequestDetail => {
    chain.push({ kind: 'request.failed', actor: 'portal', status: 'failed', label: 'Request failed', detail, startedAt: at });
    bump(at);
    return finish('failed', detail);
  };


  // 1. the runtime rendered the change-set (or refused the draft)
  if (record.prepareError !== undefined) {
    chain.push({ kind: 'change.prepared', actor: 'portal', status: 'failed', label: 'Git change prepared', detail: record.prepareError, startedAt: record.preparedAt, metadata: { component: 'runtime', branch: record.branch } });
    return fail(`the change could not be prepared: ${record.prepareError}`, record.preparedAt);
  }
  chain.push({
    kind: 'change.prepared', actor: 'portal', status: record.preparedAt ? 'ok' : 'pending', label: 'Git change prepared',
    detail: record.effects.join('; ') || undefined, startedAt: record.preparedAt,
    metadata: { component: 'runtime', branch: record.branch, files: record.diff?.files.length ?? 0 },
  });
  bump(record.preparedAt);

  // 2. the pull request
  if (record.publishError !== undefined) {
    chain.push({ kind: 'pr.opened', actor: 'portal', status: 'failed', label: 'PR opened', detail: record.publishError, startedAt: record.publishedAt, metadata: { component: 'git', branch: record.branch } });
    return fail(`the pull request could not be opened: ${record.publishError}`, record.publishedAt);
  }
  if (record.pullRequest === undefined) {
    const detail = record.notConfigured ?? 'no pull request has been opened yet';
    chain.push({ kind: 'pr.opened', actor: 'portal', status: 'pending', label: 'PR opened', detail, metadata: { component: 'git', branch: record.branch } });
    return finish('draft', detail);
  }
  chain.push({
    kind: 'pr.opened', actor: 'portal', status: 'ok', label: 'PR opened', startedAt: record.publishedAt,
    detail: `#${record.pullRequest.number} on ${record.branch}`,
    metadata: { component: 'git', pullRequest: record.pullRequest.number, ...(record.pullRequest.url ? { url: record.pullRequest.url } : {}), branch: record.branch },
  });
  bump(record.publishedAt);

  // 3. merge, as the provider reports it
  const pr = input.pullRequest;
  if (pr === undefined || 'error' in pr) {
    const detail = pr === undefined ? 'pull request state has not been observed' : `pull request state could not be read: ${pr.error}`;
    chain.push({ kind: 'pr.merged', actor: 'git', status: 'pending', label: 'PR merged', detail, metadata: { component: 'git', pullRequest: record.pullRequest.number } });
    return finish('pending-merge', detail);
  }
  if (pr.state === 'declined') {
    chain.push({ kind: 'pr.rejected', actor: 'git', status: 'denied', label: 'PR rejected', detail: 'the pull request was closed without merging; the Agent is unchanged', startedAt: pr.closedAt, metadata: { component: 'git', pullRequest: record.pullRequest.number } });
    bump(pr.closedAt);
    return finish('rejected');
  }
  if (pr.state === 'open') {
    const detail = 'waiting for the pull request to be reviewed and merged';
    chain.push({ kind: 'pr.merged', actor: 'git', status: 'pending', label: 'PR merged', detail, metadata: { component: 'git', pullRequest: record.pullRequest.number } });
    return finish('pending-merge', detail);
  }
  chain.push({ kind: 'pr.merged', actor: 'git', status: 'ok', label: 'PR merged', startedAt: pr.mergedAt, detail: `#${record.pullRequest.number} merged`, metadata: { component: 'git', pullRequest: record.pullRequest.number } });
  bump(pr.mergedAt);

  // 4. the runtime has loaded desired state that includes the merge
  const runtime = input.runtime;
  if (runtime === undefined || 'error' in runtime) {
    const detail = runtime === undefined ? 'the runtime has not been observed' : `the runtime management API could not be read: ${runtime.error}`;
    chain.push({ kind: 'reconciliation.started', actor: 'runtime', status: 'pending', label: 'Reconciliation started', detail, metadata: { component: 'runtime' } });
    return finish('merged', detail);
  }
  const agent = runtime.agents.find(candidate => candidate.id === record.agentId);
  // GitHub reports whole seconds and the runtime reports milliseconds, so this
  // is a time comparison, never a string one
  const reloaded = pr.mergedAt === undefined || !after(pr.mergedAt, runtime.loadedAt);
  if (runtime.configError !== undefined) {
    chain.push({ kind: 'reconciliation.started', actor: 'runtime', status: 'failed', label: 'Reconciliation started', detail: `desired state does not load: ${runtime.configError}`, startedAt: runtime.loadedAt, metadata: { component: 'runtime', loadedAt: runtime.loadedAt } });
    return fail(`the merged configuration does not load: ${runtime.configError}`, runtime.loadedAt);
  }
  // a deletion is DONE when the reloaded runtime no longer lists the Agent;
  // while it still does, Argo is pruning and its signals say how far along
  if (record.type === 'delete' && reloaded) {
    chain.push({ kind: 'reconciliation.started', actor: 'runtime', status: 'ok', label: 'Reconciliation started', detail: agent === undefined ? `the runtime no longer lists ${record.agentId}` : 'the runtime still lists the Agent; Argo is pruning it', startedAt: runtime.loadedAt, metadata: { component: 'runtime', loadedAt: runtime.loadedAt } });
    if (agent === undefined) {
      chain.push({ kind: 'request.completed', actor: 'portal', status: 'ok', label: 'Agent removed', detail: `${record.agentId} is gone from Git, the runtime and the Manager`, agentId: record.agentId, metadata: { component: 'portal' } });
      return finish('completed');
    }
    if (agent.reconciliation) {
      observed.reconciliation = agent.reconciliation;
      observed.agentStatus = agent.reconciliation.status;
      chain.push({ kind: 'argo.sync', actor: 'argo', status: agent.reconciliation.argo.state === 'degraded' ? 'failed' : 'pending', label: 'Argo prune', detail: agent.reconciliation.argo.detail, metadata: { component: 'argo', state: agent.reconciliation.argo.state } });
      if (agent.reconciliation.argo.state === 'degraded') return fail(agent.reconciliation.argo.detail, runtime.loadedAt);
    }
    return finish('reconciling', 'waiting for Argo to prune the Agent');
  }
  if (agent?.reconciliation === undefined || !reloaded) {
    const detail = !reloaded
      ? `the runtime last loaded desired state at ${runtime.loadedAt}, before the merge at ${pr.mergedAt}; waiting for Argo to sync it`
      : `the runtime does not list ${record.agentId} yet; waiting for Argo to sync the merge`;
    chain.push({ kind: 'reconciliation.started', actor: 'runtime', status: 'pending', label: 'Reconciliation started', detail, metadata: { component: 'runtime', loadedAt: runtime.loadedAt } });
    return finish('merged', detail);
  }
  const reconciliation = agent.reconciliation;
  const agentStatus = reconciliation.status;
  observed.reconciliation = reconciliation;
  observed.agentStatus = agentStatus;
  bump(runtime.loadedAt);
  chain.push({ kind: 'reconciliation.started', actor: 'runtime', status: 'ok', label: 'Reconciliation started', detail: reconciliation.git.detail, startedAt: runtime.loadedAt, metadata: { component: 'runtime', loadedAt: runtime.loadedAt, git: reconciliation.git.state } });

  // 5–7. the observed signals, in the order a deployment goes through them.
  // A signal this deployment cannot observe stays `pending` with its reason:
  // the request may still complete on the Manager's positive evidence, but
  // the node never claims to have seen something it did not.
  chain.push({ kind: 'argo.sync', actor: 'argo', status: signalStatus(reconciliation.argo.state), label: 'Argo sync', detail: reconciliation.argo.detail, metadata: { component: 'argo', state: reconciliation.argo.state } });
  chain.push({ kind: 'runtime.ready', actor: 'runtime', status: signalStatus(reconciliation.runtime.state), label: 'Runtime ready', detail: reconciliation.runtime.detail, metadata: { component: 'runtime', state: reconciliation.runtime.state } });
  const routable = reconciliation.manager.state === 'ok';
  // a disable is done when the Manager can NO LONGER route to the Agent
  let routableStatus: Status = signalStatus(reconciliation.manager.state);
  if (record.type === 'disable') routableStatus = routable ? 'pending' : 'ok';
  chain.push({
    kind: 'agent.routable', actor: 'manager',
    status: routableStatus,
    label: record.type === 'disable' ? 'Removed from Manager routing' : 'Manager routable',
    detail: reconciliation.manager.detail, metadata: { component: 'manager', state: reconciliation.manager.state },
  });

  // 8. the Agent's own folded status decides the outcome, so Request and Agent
  // can never disagree: the request is exactly as done as the agent is.
  if (agentStatus === 'degraded' || agentStatus === 'failed') {
    const broken = [reconciliation.git, reconciliation.argo, reconciliation.runtime].find(signal => signal.state === 'degraded');
    return fail(broken?.detail ?? `the Agent is ${agentStatus}`, runtime.loadedAt);
  }
  if (settled(record.type, agentStatus)) {
    chain.push({ kind: 'request.completed', actor: 'portal', status: 'ok', label: agentStatus === 'active' ? 'Active' : `Agent ${agentStatus}`, detail: reconciliation.manager.detail, agentId: record.agentId, metadata: { component: 'portal', agentStatus } });
    return finish('completed');
  }
  const waiting = chain.nodes.find(node => node.status === 'pending');
  return finish('reconciling', waiting?.detail ?? `the Agent is ${agentStatus}`);
}

export function summarise(detail: ManagementRequestDetail): ManagementRequestSummary {
  const { effects: _effects, diff: _diff, reconciliation: _reconciliation, nodes: _nodes, ...summary } = detail;
  return summary;
}

/**
 * A durable request, with the observations that explain it.
 *
 * TWO WRITES, TWO ROLES. The record says what was ASKED for and is mutable —
 * a pull request number arrives after the row exists. The events say what was
 * OBSERVED and are append-only, because a log that can be rewritten is not a
 * log. Collapsing them would force one of those two properties to give.
 *
 * ═══ THIS STORE GRANTS NOTHING ═══
 *
 * Nothing here decides whether an Agent may route. `projectRequest` reads the
 * runtime's live reconciliation on every call, so a request that once observed
 * ACTIVE cannot speak for the present. There is deliberately no status column
 * to drift, and no join from this table into a routing decision.
 *
 * The portal is a separate workspace from the runtime and cannot import
 * `@sre/events`, so the event shape is re-stated here. The SQL table and the
 * OpenAPI contract are what the two planes actually agree on — the same split
 * the generated API types already live with.
 */
export interface RequestEvent {
  eventId: string;
  type: string;
  outcome: 'pending' | 'ok' | 'failed';
  occurredAt: string;
  actor?: string;
  metadata?: Record<string, string | number | boolean>;
}

/**
 * Keys and values that must never reach an append-only table.
 *
 * The KEY check catches carelessness. The VALUE check catches the case that
 * actually happens: a provider's error message quoted verbatim into an
 * innocuous field called `reason`, carrying the token the request was rejected
 * for. Checking keys alone would have let that straight through.
 *
 * This mirrors `assertSafeMetadata` in `@sre/events`, which the portal cannot
 * import across the workspace boundary. The two must stay in step; the test
 * suite asserts the same cases on both sides.
 */
const UNSAFE_KEY = /secret|token|password|credential|apikey|api_key|authorization|bearer|private[_-]?key|cookie|session|reasoning|chain[_-]?of[_-]?thought/iu;

const UNSAFE_VALUE = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/iu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
  // provider tokens: GitHub, OpenAI-style, AWS access key ids
  /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/u,
  /\bsk-[A-Za-z0-9]{16,}/u,
  /\bAKIA[0-9A-Z]{12,}/u,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/u,
];

/**
 * Redact anything credential-shaped out of a message before it is STORED.
 *
 * A provider's error is quoted verbatim into `prepare_error` and
 * `publish_error`, and those columns are written before any event is appended —
 * so validating only at append left the credential sitting in the request row
 * while the audit event was the thing rejected. Scrubbing at the boundary puts
 * the check where the value first arrives.
 */
export function scrubMessage(message: string): string {
  let scrubbed = message;
  for (const pattern of UNSAFE_VALUE) {
    scrubbed = scrubbed.replace(new RegExp(pattern.source, `${pattern.flags.replace("u", "")}gu`), "[redacted]");
  }
  return scrubbed;
}

function assertSafe(metadata: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(metadata)) {
    if (UNSAFE_KEY.test(key)) throw new Error(`event metadata "${key}" names credential material`);
    // nesting is where a payload hides, so it is not representable rather than
    // discouraged
    if (value !== null && typeof value === 'object') throw new Error(`event metadata "${key}" is not a scalar`);
    if (typeof value === 'string') {
      for (const pattern of UNSAFE_VALUE) {
        if (pattern.test(value)) throw new Error(`event metadata "${key}" holds something shaped like a credential`);
      }
    }
  }
}

interface RequestRow {
  request_id: string; agent_id: string; environment: string; type: string; requested_by: string;
  created_at: Date; branch: string; effects: string[]; diff: ChangeSetDiff | null;
  prepared_at: Date | null; prepare_error: string | null; published_at: Date | null; publish_error: string | null;
  not_configured: string | null; pull_request_number: number | null; pull_request_url: string | null;
  pull_request_state: string | null; pull_request_state_at: Date | null;
}

/**
 * The minimum this store needs from a database.
 *
 * Narrow on purpose: the plugin then owns no import of `pg`, and Backstage's
 * own configured connection can be adapted to it rather than a second pool
 * being opened beside the one the backend already manages.
 */
export interface SqlClient {
  query<T>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
  end(): Promise<void>;
}

/** Minimal shape of the Knex instance Backstage hands out. */
interface KnexLike {
  raw(sql: string, bindings?: readonly unknown[]): Promise<unknown>;
}

/**
 * Adapt Backstage's database service to `SqlClient`.
 *
 * `knex.raw` on PostgreSQL answers with `{ rows, rowCount }`, which is the
 * shape this store already speaks. Adapting rather than opening a second pool
 * keeps connection limits, credentials and lifecycle in one place — the
 * backend's.
 */
export function knexSqlClient(knex: KnexLike): SqlClient {
  return {
    async query<T>(text: string, values: unknown[] = []) {
      const result = (await knex.raw(text, values)) as { rows?: T[]; rowCount?: number | null };
      return { rows: result.rows ?? [], rowCount: result.rowCount ?? null };
    },
    // the backend owns the pool's lifetime, so this store must not end it
    async end() {},
  };
}

export class PostgresRequestStore implements RequestStore {
  readonly mode = 'real' as const;
  readonly #sql: SqlClient;
  readonly #environment: string;

  constructor(sql: SqlClient, environment: string) {
    this.#sql = sql;
    this.#environment = environment;
  }

  async record(request: RequestRecord): Promise<void> {
    await this.#sql.query(
      `INSERT INTO sre_management_request(request_id, agent_id, environment, type, requested_by, created_at, branch, effects, diff)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (request_id, environment) DO NOTHING`,
      [request.id, request.agentId, this.#environment, request.type, request.requestedBy, request.createdAt, request.branch, JSON.stringify(request.effects ?? []), request.diff ? JSON.stringify(request.diff) : null],
    );
    await this.append(request.id, {
      eventId: `management-request:${request.id}:REQUEST_CREATED`,
      type: 'REQUEST_CREATED',
      outcome: 'ok',
      occurredAt: request.createdAt,
      actor: request.requestedBy,
      metadata: { agentId: request.agentId, changeType: request.type },
    });
  }

  async update(id: string, patch: Partial<RequestRecord>): Promise<RequestRecord | undefined> {
    const current = await this.get(id);
    if (current === undefined) return undefined;
    const next = { ...current, ...patch };
    await this.#sql.query(
      `UPDATE sre_management_request SET
         branch = $2, effects = $3, diff = $4,
         prepared_at = $5, prepare_error = $6,
         published_at = $7, publish_error = $8, not_configured = $9,
         pull_request_number = $10, pull_request_url = $11,
         pull_request_state = $12, pull_request_state_at = $13
       WHERE request_id = $1 AND environment = $14`,
      [
        id, next.branch, JSON.stringify(next.effects ?? []), next.diff ? JSON.stringify(next.diff) : null,
        next.preparedAt ?? null, next.prepareError ?? null,
        next.publishedAt ?? null, next.publishError ?? null, next.notConfigured ?? null,
        next.pullRequest?.number ?? null, next.pullRequest?.url ?? null,
        next.pullRequestState?.state ?? null, next.pullRequestState?.observedAt ?? null,
        this.#environment,
      ],
    );
    /*
     * The observations this patch implies. Each id is derived from what is
     * being observed, so a retry of the same patch appends nothing — which is
     * what makes an at-least-once caller safe here.
     */
    if (patch.pullRequest?.number !== undefined) {
      await this.append(id, {
        eventId: `management-request:${id}:PR_OPENED:ok:${patch.pullRequest.number}`,
        type: 'PR_OPENED', outcome: 'ok', occurredAt: next.publishedAt ?? new Date().toISOString(),
        metadata: { pullRequest: patch.pullRequest.number, ...(patch.pullRequest.url ? { url: patch.pullRequest.url } : {}) },
      });
    }
    if (patch.pullRequestState?.state === 'merged') {
      await this.append(id, {
        eventId: `management-request:${id}:PR_MERGED`,
        type: 'PR_MERGED', outcome: 'ok',
        occurredAt: patch.pullRequestState.mergedAt ?? patch.pullRequestState.observedAt,
        metadata: {},
      });
    }
    /*
     * A FAILURE IS AN OUTCOME OF ITS PHASE, not a separate `FAILED` fact.
     *
     * A standalone FAILED event can never be superseded: a later success is a
     * different type, so the projection keeps reporting failure while the
     * request plainly recovered — the log and the console then disagree. Typing
     * the failure as the phase it belongs to means the retry's success is a
     * later observation OF THE SAME TYPE, and supersedes it by the ordinary
     * rule.
     */
    /*
     * Every id names the ATTEMPT it belongs to, not just the phase.
     *
     * A constant success id collides with an earlier success, so a
     * success → failure → success sequence silently lost its last observation
     * and the timeline claimed the request had failed. The instant discriminates
     * attempts; a genuine retry within the same millisecond still collapses,
     * which is the case idempotency is actually for.
     */
    const at = new Date().toISOString();
    if (patch.prepareError !== undefined) {
      const reason = scrubMessage(patch.prepareError);
      await this.append(id, {
        eventId: `management-request:${id}:REQUEST_PREPARED:${attempt(reason)}:${at}`,
        type: 'REQUEST_PREPARED', outcome: 'failed', occurredAt: at,
        metadata: { reason: reason.slice(0, 500) },
      });
    } else if (patch.preparedAt !== undefined) {
      await this.append(id, {
        eventId: `management-request:${id}:REQUEST_PREPARED:ok:${patch.preparedAt}`,
        type: 'REQUEST_PREPARED', outcome: 'ok', occurredAt: patch.preparedAt, metadata: {},
      });
    }
    if (patch.publishError !== undefined) {
      const reason = scrubMessage(patch.publishError);
      await this.append(id, {
        eventId: `management-request:${id}:PR_OPENED:${attempt(reason)}:${at}`,
        type: 'PR_OPENED', outcome: 'failed', occurredAt: at,
        metadata: { reason: reason.slice(0, 500) },
      });
    }
    return next;
  }

  async list(): Promise<RequestRecord[]> {
    const result = await this.#sql.query<RequestRow>(
      'SELECT * FROM sre_management_request WHERE environment = $1 ORDER BY created_at DESC LIMIT 200',
      [this.#environment],
    );
    return result.rows.map(toRecord);
  }

  async get(id: string): Promise<RequestRecord | undefined> {
    const result = await this.#sql.query<RequestRow>(
      'SELECT * FROM sre_management_request WHERE request_id = $1 AND environment = $2',
      [id, this.#environment],
    );
    return result.rows[0] === undefined ? undefined : toRecord(result.rows[0]);
  }

  /**
   * The stream a request's events belong to.
   *
   * ENVIRONMENT-QUALIFIED. The event table is generic and carries no
   * environment column, so two environments using the same request id would
   * otherwise share one timeline — and, because the ids are derived, one
   * environment's observation would be silently dropped as a duplicate of the
   * other's.
   */
  #stream(requestId: string): string {
    return `${this.#environment}/${requestId}`;
  }

  /** Append one observation. Idempotent by `eventId`; a repeat is a no-op. */
  async append(requestId: string, event: RequestEvent): Promise<boolean> {
    assertSafe(event.metadata ?? {});
    const result = await this.#sql.query(
      `INSERT INTO sre_execution_event(event_id, stream_kind, stream_id, occurred_at, source, actor, type, outcome, metadata)
       VALUES ($1,'management-request',$2,$3,'management-api',$4,$5,$6,$7)
       ON CONFLICT (event_id) DO NOTHING`,
      [`${this.#environment}/${event.eventId}`, this.#stream(requestId), event.occurredAt, event.actor ?? null, event.type, event.outcome, JSON.stringify(event.metadata ?? {})],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Every observation about one request, oldest first. */
  async events(requestId: string): Promise<RequestEvent[]> {
    const result = await this.#sql.query<{ event_id: string; type: string; outcome: string; occurred_at: Date; actor: string | null; metadata: Record<string, string | number | boolean> }>(
      `SELECT event_id, type, outcome, occurred_at, actor, metadata FROM sre_execution_event
        WHERE stream_kind = 'management-request' AND stream_id = $1
        ORDER BY occurred_at, event_id`,
      [this.#stream(requestId)],
    );
    return result.rows.map((row) => ({
      eventId: row.event_id, type: row.type, outcome: row.outcome as RequestEvent['outcome'],
      occurredAt: row.occurred_at.toISOString(),
      ...(row.actor === null ? {} : { actor: row.actor }),
      metadata: row.metadata,
    }));
  }
}

/**
 * A stable discriminator for one failure, so a repeat of the SAME failure
 * collapses and a different one does not.
 *
 * A 32-bit rolling hash collided on strings as short as two characters, which
 * meant a second, different failure could be silently dropped as a duplicate.
 * SHA-256 truncated to 16 hex characters has no such neighbours.
 */
function attempt(reason: string): string {
  return createHash('sha256').update(reason).digest('hex').slice(0, 16);
}

function toRecord(row: RequestRow): RequestRecord {
  return {
    id: row.request_id,
    agentId: row.agent_id,
    type: row.type as RequestType,
    requestedBy: row.requested_by,
    createdAt: row.created_at.toISOString(),
    branch: row.branch,
    effects: row.effects ?? [],
    ...(row.diff === null ? {} : { diff: row.diff }),
    ...(row.prepared_at === null ? {} : { preparedAt: row.prepared_at.toISOString() }),
    ...(row.prepare_error === null ? {} : { prepareError: row.prepare_error }),
    ...(row.published_at === null ? {} : { publishedAt: row.published_at.toISOString() }),
    ...(row.publish_error === null ? {} : { publishError: row.publish_error }),
    ...(row.not_configured === null ? {} : { notConfigured: row.not_configured }),
    ...(row.pull_request_number === null ? {} : { pullRequest: { number: row.pull_request_number, ...(row.pull_request_url ? { url: row.pull_request_url } : {}) } }),
    ...(row.pull_request_state === null || row.pull_request_state_at === null
      ? {}
      : { pullRequestState: { state: row.pull_request_state as PullRequestState['state'], observedAt: row.pull_request_state_at.toISOString() } }),
  };
}
