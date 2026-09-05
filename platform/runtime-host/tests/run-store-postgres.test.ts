import { describe, expect, it, vi } from "vitest";
import { PostgresRunStore, RunHistoryUnavailableError, type RunRecord } from "../src/management/run-store.ts";

/**
 * A run record that only ever lived in one pod's memory was indistinguishable
 * from a run that never happened, and a failed write was worse: silent. The
 * durable write is what makes the history real; the metric is what makes its
 * loss visible.
 *
 * This runs without a database on purpose — a durability contract that is only
 * checked when someone sets an env var is not checked.
 */

const record = (requestId: string): RunRecord => ({
  requestId,
  startedAt: new Date().toISOString(),
  durationMs: 100,
  status: "complete",
  userSubjectHash: "a".repeat(64),
  environment: "prod",
  agents: ["keycloak"],
  workloads: ["sre-agent-keycloak"],
  toolCalls: 5,
  deniedToolCalls: 0,
  evidenceCount: 3,
  modelProfiles: ["tool-caller"],
  nodes: [],
});

function writer() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    // a real pg pool returns a result object; returning `undefined` made the
    // store's read path throw a TypeError and be caught, so a "no rows" test
    // was actually exercising a crash
    query: async (text: string, values: unknown[]) => { calls.push({ text, values }); return { rows: [] }; },
    end: async () => { /* nothing to close */ },
  };
}

describe("run history is durable, and its loss is visible", () => {
  it("writes every run to the append-only event table", async () => {
    const pool = writer();
    const store = new PostgresRunStore("postgres://unused", { pool });
    store.record(record("req-1"));
    await vi.waitFor(() => expect(pool.calls).toHaveLength(1));
    const [call] = pool.calls;
    expect(call?.text).toContain("sre_execution_event");
    // idempotent by event id, so a retry cannot double-count a run
    expect(call?.text).toContain("ON CONFLICT DO NOTHING");
    expect(call?.values[0]).toBe("run:req-1");
    expect(call?.values[2]).toBe("req-1");
  });

  it("reports a failed write instead of swallowing or throwing it", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => { errors.push(String(line)); });
    const failing = { query: async () => { throw new Error("connection refused"); }, end: async () => { /* noop */ } };
    const store = new PostgresRunStore("postgres://unused", { pool: failing });
    // must not throw into the caller: the user's answer is already sent
    expect(() => store.record(record("req-2"))).not.toThrow();
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
    expect(errors.join("\n")).toContain("run.record_failed");
    expect(errors.join("\n")).toContain("req-2");
    spy.mockRestore();
  });

  it("still serves the runs this pod saw, so the console does not go blank", async () => {
    const pool = writer();
    const store = new PostgresRunStore("postgres://unused", { pool });
    store.record(record("req-3"));
    // the read path used by the management routes must keep working when
    // Postgres is configured — returning nothing would read as "no runs"
    const getResult = await store.get("req-3");
    expect(getResult?.requestId).toBe("req-3");
    const listResult = await store.list(50);
    expect(listResult.map((run) => run.requestId)).toContain("req-3");
  });

  it("records the run even when the durable write is still in flight", async () => {
    const slow = { query: () => new Promise<unknown>(() => { /* never settles */ }), end: async () => { /* noop */ } };
    const store = new PostgresRunStore("postgres://unused", { pool: slow });
    store.record(record("req-4"));
    const result = await store.get("req-4");
    expect(result).toBeDefined();
  });

  it("reconstructs runs from the database when not in the local ring", async () => {
    const pool = writer();
    const store = new PostgresRunStore("postgres://unused", { pool });
    store.record(record("req-5"));
    await vi.waitFor(() => expect(pool.calls).toHaveLength(1));

    // Simulate a fresh store over the same written data
    const mockDb = {
      query: async (text: string, values: unknown[]) => {
        if (text.includes("WHERE event_id")) {
          // Simulate the database returning the row
          const eventId = values[0] as string;
          const requestId = eventId.replace("run:", "");
          const rec = record(requestId);
          return {
            rows: [{
              stream_id: requestId,
              occurred_at: rec.startedAt,
              metadata: {
                agents: rec.agents,
                status: rec.status,
                durationMs: rec.durationMs,
                evidenceCount: rec.evidenceCount,
                userSubjectHash: rec.userSubjectHash,
                environment: rec.environment,
                workloads: rec.workloads,
                toolCalls: rec.toolCalls,
                deniedToolCalls: rec.deniedToolCalls,
                modelProfiles: rec.modelProfiles,
              },
            }],
          };
        }
        return { rows: [] };
      },
      end: async () => { /* noop */ },
    };
    const freshStore = new PostgresRunStore("postgres://unused", { pool: mockDb });
    const result = await freshStore.get("req-5");
    expect(result?.requestId).toBe("req-5");
    expect(result?.userSubjectHash).toBe("a".repeat(64));
    expect(result?.environment).toBe("prod");
  });

  it("returns undefined when run is not found in ring or database", async () => {
    const pool = writer();
    const store = new PostgresRunStore("postgres://unused", { pool });
    const result = await store.get("req-nonexistent");
    expect(result).toBeUndefined();
  });

  it("list() returns most-recent-first and respects limit", async () => {
    const pool = writer();
    const store = new PostgresRunStore("postgres://unused", { pool });
    const rec1 = record("req-old");
    const rec2 = record("req-middle");
    const rec3 = record("req-new");
    store.record(rec1);
    store.record(rec2);
    store.record(rec3);
    await vi.waitFor(() => expect(pool.calls).toHaveLength(3));

    const results = await store.list(2);
    expect(results).toHaveLength(2);
    // Should be most recent first
    expect(results[0]?.requestId).toBe("req-new");
    expect(results[1]?.requestId).toBe("req-middle");
  });

  it("does not let this pod's own runs hide the rest of the estate", async () => {
    // the defect this replaced: a non-empty local ring short-circuited the
    // query, so a replica that had served one run reported exactly one run
    const dbRuns = ["req-from-another-replica-1", "req-from-another-replica-2"];
    const pool = {
      query: async (text: string) => {
        if (text.includes("stream_kind")) {
          return { rows: dbRuns.map((id, index) => ({
            stream_id: id,
            occurred_at: new Date(1_700_000_000_000 + index).toISOString(),
            metadata: { agents: ["keycloak"], status: "complete", durationMs: 10, evidenceCount: 1, userSubjectHash: "a".repeat(64), toolCalls: 0 },
          })) };
        }
        return { rows: [] };
      },
      end: async () => { /* noop */ },
    };
    const store = new PostgresRunStore("postgres://unused", { pool });
    store.record(record("req-this-pod"));
    const listed = await store.list(50);
    const ids = listed.map((run) => run.requestId);
    expect(ids).toContain("req-this-pod");
    for (const id of dbRuns) expect(ids).toContain(id);
  });

  it("says so when the history cannot be read, instead of reporting an empty estate", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => { errors.push(String(line)); });
    const broken = { query: async () => { throw new Error("connection refused"); }, end: async () => { /* noop */ } };
    const store = new PostgresRunStore("postgres://unused", { pool: broken });
    await store.list(50);
    expect(errors.join("\n")).toContain("run.read_failed");
    spy.mockRestore();
  });

  it("marks a database-read run as having no retained trace", async () => {
    const pool = {
      query: async (text: string, values: unknown[]) => text.includes("WHERE event_id")
        ? { rows: [{ stream_id: String(values[0]).replace("run:", ""), occurred_at: new Date().toISOString(), metadata: { agents: [], status: "complete", durationMs: 1, evidenceCount: 0 } }] }
        : { rows: [] },
      end: async () => { /* noop */ },
    };
    const store = new PostgresRunStore("postgres://unused", { pool });
    const run = await store.get("req-elsewhere");
    // an empty node list must not read as "nothing happened"
    expect(run?.nodes).toEqual([]);
    expect(run?.traceRetained).toBe(false);
  });
});
/**
 * "NOT FOUND" AND "CANNOT LOOK" ARE DIFFERENT ANSWERS.
 *
 * Observed in the cluster: PostgreSQL was stopped, a run that demonstrably
 * existed in sre_execution_event was requested, and the API returned 404. The
 * failure was logged and metered — so it was not silent — but the answer given
 * to the operator was that the run never happened. Someone investigating an
 * incident would stop looking.
 *
 * A read that could not be performed must say so, and say it is worth retrying.
 */
describe("an unreadable history is not reported as an empty one", () => {
  it("distinguishes a run that is absent from a database that cannot be reached", async () => {
    const broken = { query: async () => { throw new Error("connect ECONNREFUSED"); }, end: async () => { /* noop */ } };
    const spy = vi.spyOn(console, "error").mockImplementation(() => { /* silence */ });
    const store = new PostgresRunStore("postgres://unused", { pool: broken });
    await expect(store.get("req-unreadable")).rejects.toThrow(RunHistoryUnavailableError);
    spy.mockRestore();
  });

  it("still returns undefined for a run the database genuinely does not hold", async () => {
    const empty = { query: async () => ({ rows: [] }), end: async () => { /* noop */ } };
    const store = new PostgresRunStore("postgres://unused", { pool: empty });
    await expect(store.get("req-absent")).resolves.toBeUndefined();
  });
});
