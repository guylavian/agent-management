import { z } from "zod";

/**
 * Bounded in-memory record of recent runs, for the management Runs view and
 * the multi-agent execution graph (TDD §45/§46).
 *
 * It stores only what the graph needs: who initiated, which workloads executed,
 * which MCP/tool was called and whether it was allowed. It deliberately never
 * stores the question's answer text, model reasoning, tool payloads, or any
 * credential — a management console is not an exfiltration path for the data
 * the evidence pipeline works hard to redact.
 *
 * ponytail: in-memory and bounded. Durable run history needs a store with a
 * retention policy and its own authorization; wire one in when runs must
 * survive a restart.
 */

export const RUN_NODE_KINDS = ["manager.route", "specialist", "authorization.check", "workload.token", "tool.request", "toolhive.call", "evidence", "domain.escalation", "synthesis"] as const;

export const runNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(RUN_NODE_KINDS),
    label: z.string().min(1).max(200),
    /** parent node id; absent for the request root */
    parentId: z.string().min(1).optional(),
    status: z.enum(["ok", "denied", "failed", "timeout"]),
    startedAt: z.string(),
    durationMs: z.number().int().min(0),
    agentId: z.string().min(1).optional(),
    mcp: z.string().min(1).optional(),
    tool: z.string().min(1).optional(),
    /** which bounded round produced this node; Round 2 is a runtime feature */
    round: z.number().int().min(1).max(2).optional(),
  })
  .strict();

export type RunNode = z.infer<typeof runNodeSchema>;

export const runRecordSchema = z
  .object({
    requestId: z.string().min(1),
    startedAt: z.string(),
    durationMs: z.number().int().min(0),
    status: z.enum(["complete", "partial", "failed"]),
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
  })
  .strict();

export type RunRecord = z.infer<typeof runRecordSchema>;

export interface RunSummary {
  requestId: string;
  startedAt: string;
  durationMs: number;
  status: RunRecord["status"];
  userSubjectHash: string;
  agents: string[];
  toolCalls: number;
  evidenceCount: number;
}

export interface RunStore {
  record(run: RunRecord): void;
  list(limit?: number): RunSummary[];
  get(requestId: string): RunRecord | undefined;
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

  list(limit = 50): RunSummary[] {
    return [...this.#runs.values()]
      .reverse()
      .slice(0, limit)
      .map((run) => ({
        requestId: run.requestId,
        startedAt: run.startedAt,
        durationMs: run.durationMs,
        status: run.status,
        userSubjectHash: run.userSubjectHash,
        agents: run.agents,
        toolCalls: run.toolCalls,
        evidenceCount: run.evidenceCount,
      }));
  }

  get(requestId: string): RunRecord | undefined {
    return this.#runs.get(requestId);
  }
}
