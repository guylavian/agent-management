import { describe, expect, it, vi } from "vitest";
import { PostgresRunStore, type RunRecord } from "../src/management/run-store.ts";

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
    query: async (text: string, values: unknown[]) => { calls.push({ text, values }); return undefined; },
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
    expect(store.get("req-3")?.requestId).toBe("req-3");
    expect(store.list(50).map((run) => run.requestId)).toContain("req-3");
  });

  it("records the run even when the durable write is still in flight", () => {
    const slow = { query: () => new Promise<unknown>(() => { /* never settles */ }), end: async () => { /* noop */ } };
    const store = new PostgresRunStore("postgres://unused", { pool: slow });
    store.record(record("req-4"));
    expect(store.get("req-4")).toBeDefined();
  });
});
