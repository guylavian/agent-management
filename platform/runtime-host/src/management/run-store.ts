import { Pool } from "pg";
import { z } from "zod";
import { incrementMetric } from "@sre/telemetry";

/**
 * Bounded in-memory execution trace for recent runs (TDD §45/§46).
 *
 * A run is a tree of events, and each one answers one of three questions:
 * what was INTENDED, whether the runtime ALLOWED it, and what actually
 * EXECUTED. Keeping only the third is what makes most audit trails useless —
 * a request that was refused leaves no trace at all, so "did it try?" and "did
 * it succeed?" become indistinguishable.
 *
 * WHAT IS DELIBERATELY ABSENT, and stays absent: model reasoning, tool
 * arguments, tool payloads, the answer text, and any credential. The redacted
 * question and the task each agent was given are recorded — those are inputs
 * and instructions, not reasoning — and everything else is a name, a status or
 * a count. A management console is not an exfiltration path for the data the
 * evidence pipeline works to redact.
 *
 * ponytail: in-memory and bounded. Durable run history needs a store with a
 * retention policy and its own authorization; wire one in when runs must
 * survive a restart.
 */

/**
 * The event vocabulary.
 *
 * Three things are worth recording about any step, and the list is grouped that
 * way: what was INTENDED, whether policy ALLOWED it, and what actually
 * EXECUTED. An operator asking "did the agent try something it should not
 * have?" is asking about the first two, and no answer is possible if only the
 * third is kept.
 *
 * The trailing group names capabilities this platform deliberately does not
 * have. They are here so that adding one later is an emission, not a schema
 * migration through the store, the OpenAPI document and two generated copies.
 */
export const RUN_NODE_KINDS = [
  // request lifecycle
  "user.request", "manager.route", "followup.route", "run.completed",
  // agent lifecycle
  "specialist", "agent.action", "agent.result", "domain.escalation",
  // enforcement — what the runtime decided about an intent
  "authorization.check", "workload.token",
  // execution — what actually reached a provider, and what came back
  "tool.request", "toolhive.call", "evidence", "synthesis",
  "error",
  // reserved: no code path emits these yet
  "approval.requested", "approval.granted", "write.action", "retry", "verify.result",
  // management requests — a platform CHANGE traced with the same vocabulary.
  // Emitted by the management plane (which sees pull requests); the runtime
  // never records these, but the contract is one so the console has one Flow.
  "request.created", "change.prepared", "pr.opened", "pr.merged", "pr.rejected",
  "reconciliation.started", "argo.sync", "runtime.ready", "agent.routable",
  "request.completed", "request.failed",
] as const;

/** Who the step belongs to. `runtime` is the enforcement itself — not an agent. */
export const RUN_ACTORS = ["user", "manager", "specialist", "runtime", "portal", "git", "argo"] as const;

/**
 * Open key/value for event-specific facts, restricted to scalars.
 *
 * Scalars only, and bounded, for the same reason `DomainHandoff.sanitizedFacts`
 * is: an open object is exactly the shape a raw tool payload or a captured
 * response would fit through, and the whole point of this record is that such
 * things never enter it. A nested value cannot be expressed here at all.
 */
const scalarSchema = z.union([z.string().max(500), z.number(), z.boolean()]);

export const runNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(RUN_NODE_KINDS),
    label: z.string().min(1).max(200),
    /** parent node id; absent for the request root */
    parentId: z.string().min(1).optional(),
    /** `pending`: a step the trace is waiting on — only management requests emit it */
    status: z.enum(["ok", "denied", "failed", "timeout", "pending"]),
    startedAt: z.string(),
    durationMs: z.number().int().min(0),
    actor: z.enum(RUN_ACTORS),
    /** the human-readable substance of the step: a task, a rationale, a denial reason */
    detail: z.string().max(2_000).optional(),
    agentId: z.string().min(1).optional(),
    mcp: z.string().min(1).optional(),
    tool: z.string().min(1).optional(),
    /** which bounded round produced this node; Round 2 is a runtime feature */
    round: z.number().int().min(1).max(2).optional(),
    metadata: z.record(z.string().max(64), scalarSchema).optional(),
  })
  .strict();

export type RunNode = z.infer<typeof runNodeSchema>;

export const runRecordSchema = z
  .object({
    requestId: z.string().min(1),
    startedAt: z.string(),
    durationMs: z.number().int().min(0),
    status: z.enum(["complete", "partial", "failed"]),
    /**
     * What was asked, AFTER the same redaction the model sees.
     *
     * A trace that cannot show the question cannot answer whether routing was
     * reasonable, which is most of what anyone opens it for. It is stored from
     * the already-redacted string rather than the request body, so this is not
     * a second copy of the raw input living under a weaker rule.
     */
    question: z.string().max(2_000).optional(),
    /** hashed human initiator — traces never carry a raw subject (TDD §13/§25) */
    userSubjectHash: z.string().regex(/^[a-f0-9]{64}$/u),
    environment: z.string().min(1),
    /** agents the Manager routed to */
    agents: z.array(z.string().min(1)),
    /** workload client ids that actually executed */
    workloads: z.array(z.string().min(1)),
    toolCalls: z.number().int().min(0),
    deniedToolCalls: z.number().int().min(0),
    evidenceCount: z.number().int().min(0),
    modelProfiles: z.array(z.string().min(1)),
    nodes: z.array(runNodeSchema),
    /**
     * Whether the execution trace above is the real one.
     *
     * The durable event table stores scalars, so a run read back from it has
     * no node tree. Absent (or true) means these nodes are the run's own;
     * false means the trace was not retained and an empty list must not be
     * read as "nothing happened".
     */
    traceRetained: z.boolean().optional(),
  })
  .strict();

export type RunRecord = z.infer<typeof runRecordSchema>;

export interface RunSummary {
  requestId: string;
  startedAt: string;
  durationMs: number;
  status: RunRecord["status"];
  question?: string;
  userSubjectHash: string;
  agents: string[];
  toolCalls: number;
  evidenceCount: number;
}

export interface RunStore {
  record(run: RunRecord): void;
  list(limit?: number): Promise<RunSummary[]>;
  get(requestId: string): Promise<RunRecord | undefined>;
  /** present only on durable stores; readiness uses it to prove the database answers */
  ping?(): Promise<void>;
}

/** Fixed-capacity ring so a long-lived process cannot grow without bound. */
export class InMemoryRunStore implements RunStore {
  readonly #capacity: number;
  readonly #runs = new Map<string, RunRecord>();

  constructor(capacity = 200) {
    if (capacity < 1) throw new Error("run store capacity must be at least 1");
    this.#capacity = capacity;
  }

  record(run: RunRecord): void {
    const parsed = runRecordSchema.parse(run);
    // re-inserting refreshes recency, so delete first
    this.#runs.delete(parsed.requestId);
    this.#runs.set(parsed.requestId, parsed);
    while (this.#runs.size > this.#capacity) {
      const oldest = this.#runs.keys().next();
      if (oldest.done === true) break;
      this.#runs.delete(oldest.value);
    }
  }

  async list(limit = 50): Promise<RunSummary[]> {
    return [...this.#runs.values()]
      .reverse()
      .slice(0, limit)
      .map((run) => ({
        requestId: run.requestId,
        startedAt: run.startedAt,
        durationMs: run.durationMs,
        status: run.status,
        ...(run.question === undefined ? {} : { question: run.question }),
        userSubjectHash: run.userSubjectHash,
        agents: run.agents,
        toolCalls: run.toolCalls,
        evidenceCount: run.evidenceCount,
      }));
  }

  async get(requestId: string): Promise<RunRecord | undefined> {
    return this.#runs.get(requestId);
  }
}

/** The slice of a pg Pool this store needs; narrowed so tests can supply one. */
export interface RunEventWriter {
  query(text: string, values: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

/**
 * Durable run history.
 *
 * The write goes to the append-only event table, so a record survives the pod
 * that made it and is visible to every replica through the database. The READ
 * path is a local ring, because RunStore is synchronous and the console asks
 * for recent runs on a request thread — so a pod serves the runs it saw, while
 * the durable record of ALL of them is the table.
 *
 * A failed write never breaks the answer, but it is never silent either: the
 * whole point of the finding was that a swallowed failure is indistinguishable
 * from a run that never happened.
 */
export class PostgresRunStore implements RunStore {
  readonly #pool: RunEventWriter;
  readonly #recent: InMemoryRunStore;

  constructor(connectionString: string, options: { recentCapacity?: number; pool?: RunEventWriter } = {}) {
    // the pool is injectable so the durability contract can be tested without a
    // database; production always builds its own
    this.#pool = options.pool ?? new Pool({ connectionString, max: 10 });
    this.#recent = new InMemoryRunStore(options.recentCapacity ?? 200);
  }

  record(run: RunRecord): void {
    const parsed = runRecordSchema.parse(run);
    this.#recent.record(parsed);
    // fire-and-forget: the caller already has its answer, and waiting on the
    // database to hand it over would make history a dependency of correctness
    void this.#pool.query(
      "INSERT INTO sre_execution_event(event_id, stream_kind, stream_id, occurred_at, source, type, outcome, metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
      [
        `run:${parsed.requestId}`,
        "run",
        parsed.requestId,
        new Date(parsed.startedAt).toISOString(),
        "runtime",
        "run.completed",
        parsed.status === "complete" ? "ok" : "failed",
        JSON.stringify({
          agents: parsed.agents,
          status: parsed.status,
          durationMs: parsed.durationMs,
          evidenceCount: parsed.evidenceCount,
          userSubjectHash: parsed.userSubjectHash,
          environment: parsed.environment,
          workloads: parsed.workloads,
          toolCalls: parsed.toolCalls,
          deniedToolCalls: parsed.deniedToolCalls,
          modelProfiles: parsed.modelProfiles,
          ...(parsed.question === undefined ? {} : { question: parsed.question }),
        }),
      ],
    ).catch((error: unknown) => {
      // observable, not thrown: throwing here would surface as an unhandled
      // rejection long after the response, which is how a lost audit record
      // stays lost
      incrementMetric("sre_run_record_failures_total");
      console.error(JSON.stringify({ level: "error", event: "run.record_failed", requestId: parsed.requestId, detail: error instanceof Error ? error.message : String(error) }));
    });
  }

  /** Read from local ring first (fast), fall through to database if not found. */
  async list(limit = 50): Promise<RunSummary[]> {
    const recent = await this.#recent.list(limit);
    /*
     * The DATABASE is the authority for listing, not this pod's ring.
     * Short-circuiting on a non-empty ring returned only the runs this replica
     * happened to serve — which is the very thing durable history exists to
     * fix. The ring is merged in afterwards because a run recorded moments ago
     * may not have been flushed yet.
     */
    try {
      const result = await this.#pool.query(
        "SELECT stream_id, occurred_at, metadata FROM sre_execution_event WHERE stream_kind = $1 ORDER BY occurred_at DESC LIMIT $2",
        ["run", limit],
      ) as { rows?: Array<{ stream_id: string; occurred_at: string; metadata: Record<string, unknown> }> };
      const stored = (result.rows ?? []).map((row) => ({
        requestId: row.stream_id,
        startedAt: row.occurred_at,
        durationMs: (row.metadata.durationMs as number) ?? 0,
        status: (row.metadata.status as "complete" | "partial" | "failed") ?? "failed",
        ...(row.metadata.question !== undefined ? { question: String(row.metadata.question) } : {}),
        userSubjectHash: String(row.metadata.userSubjectHash ?? ""),
        agents: (row.metadata.agents as string[]) ?? [],
        toolCalls: (row.metadata.toolCalls as number) ?? 0,
        evidenceCount: (row.metadata.evidenceCount as number) ?? 0,
      }));
      const seen = new Set(stored.map((run) => run.requestId));
      const merged = [...stored, ...recent.filter((run) => !seen.has(run.requestId))];
      merged.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
      return merged.slice(0, limit);
    } catch (error) {
      // a database that cannot be read renders as "no runs", which is
      // indistinguishable from a quiet estate — say so instead
      this.#readFailed("list", error);
      return recent;
    }
  }

  /** A failed read degrades to this pod's own history, but never silently. */
  #readFailed(operation: string, error: unknown): void {
    incrementMetric("sre_run_read_failures_total");
    console.error(JSON.stringify({ level: "error", event: "run.read_failed", operation, detail: error instanceof Error ? error.message : String(error) }));
  }

  async get(requestId: string): Promise<RunRecord | undefined> {
    // Fast path: check local ring first
    const recent = await this.#recent.get(requestId);
    if (recent !== undefined) {
      return recent;
    }
    // Fall back to database
    try {
      const result = await this.#pool.query(
        "SELECT stream_id, occurred_at, metadata FROM sre_execution_event WHERE event_id = $1 AND stream_kind = $2",
        [`run:${requestId}`, "run"],
      ) as { rows?: Array<{ stream_id: string; occurred_at: string; metadata: Record<string, unknown> }> };
      const row = result.rows?.[0];
      if (row === undefined) {
        return undefined;
      }
      return {
        requestId: row.stream_id,
        startedAt: row.occurred_at,
        durationMs: (row.metadata.durationMs as number) ?? 0,
        status: (row.metadata.status as "complete" | "partial" | "failed") ?? "failed",
        ...(row.metadata.question !== undefined ? { question: String(row.metadata.question) } : {}),
        userSubjectHash: String(row.metadata.userSubjectHash ?? ""),
        environment: String(row.metadata.environment ?? ""),
        agents: (row.metadata.agents as string[]) ?? [],
        workloads: (row.metadata.workloads as string[]) ?? [],
        toolCalls: (row.metadata.toolCalls as number) ?? 0,
        deniedToolCalls: (row.metadata.deniedToolCalls as number) ?? 0,
        evidenceCount: (row.metadata.evidenceCount as number) ?? 0,
        modelProfiles: (row.metadata.modelProfiles as string[]) ?? [],
        /*
         * The execution trace is NOT retained: the event table takes scalars,
         * and a run tree is not one. A run read back from the database
         * therefore has no nodes — which is why `traceRetained` says so rather
         * than letting an empty array read as "nothing happened".
         */
        nodes: [],
        traceRetained: false,
      };
    } catch (error) {
      this.#readFailed("get", error);
      return undefined;
    }
  }

  /** a pool is created lazily, so only a real query proves the database is reachable */
  async ping(): Promise<void> { await this.#pool.query("SELECT 1", []); }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
