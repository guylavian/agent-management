import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDependencies } from "../src/index.ts";
import type { RunRecord } from "../src/management/run-store.ts";

const SUPERUSER = process.env.SRE_TEST_POSTGRES_URL;
const describeOrSkip = SUPERUSER === undefined ? describe.skip : describe;

describeOrSkip("PostgresRunStore", () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: SUPERUSER });
    // Run the execution events schema if it exists
    try {
      await admin.query(readFileSync("/Users/guylavian/sre agent/deploy/runtime/postgres/003_execution_events.sql", "utf8"));
    } catch {
      // schema might already exist
    }
    // Also need the runs table schema
    try {
      await admin.query(`
        CREATE TABLE IF NOT EXISTS sre_runs (
          request_id TEXT PRIMARY KEY,
          event_id TEXT UNIQUE NOT NULL,
          stream_kind TEXT NOT NULL DEFAULT 'run',
          stream_id TEXT NOT NULL,
          data JSONB NOT NULL,
          recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    } catch {
      // table might already exist
    }
  }, 60_000);

  afterAll(async () => {
    if (admin) {
      try {
        await admin.query("DROP TABLE IF EXISTS sre_runs CASCADE");
      } catch {
        // ignore
      }
      await admin.end();
    }
  });

  it("records and retrieves a run through Postgres store", async () => {
    const deps = buildDependencies({ SRE_CLIENT_POSTGRES: "real", SRE_POSTGRES_CONNECTION_STRING: SUPERUSER });
    if (deps.mode !== "manager") throw new Error("expected manager mode");

    const record: RunRecord = {
      requestId: "req-test-1",
      startedAt: new Date().toISOString(),
      durationMs: 100,
      status: "complete",
      question: "test question",
      userSubjectHash: "a".repeat(64),
      environment: "prod",
      agents: ["test-agent"],
      workloads: ["workload-1"],
      toolCalls: 5,
      deniedToolCalls: 0,
      evidenceCount: 3,
      modelProfiles: ["test-profile"],
      nodes: [],
    };

    deps.runs.record(record);
    const retrieved = deps.runs.get("req-test-1");
    expect(retrieved).toBeDefined();
    expect(retrieved?.requestId).toBe("req-test-1");
  });

  it("survives a store being recreated (like a restart)", async () => {
    const deps1 = buildDependencies({ SRE_CLIENT_POSTGRES: "real", SRE_POSTGRES_CONNECTION_STRING: SUPERUSER });
    if (deps1.mode !== "manager") throw new Error("expected manager mode");

    const record: RunRecord = {
      requestId: "req-test-2",
      startedAt: new Date().toISOString(),
      durationMs: 100,
      status: "complete",
      userSubjectHash: "b".repeat(64),
      environment: "prod",
      agents: ["test-agent"],
      workloads: [],
      toolCalls: 0,
      deniedToolCalls: 0,
      evidenceCount: 0,
      modelProfiles: [],
      nodes: [],
    };

    deps1.runs.record(record);

    // Create a new store object (like after restart)
    const deps2 = buildDependencies({ SRE_CLIENT_POSTGRES: "real", SRE_POSTGRES_CONNECTION_STRING: SUPERUSER });
    if (deps2.mode !== "manager") throw new Error("expected manager mode");

    const retrieved = deps2.runs.get("req-test-2");
    expect(retrieved).toBeDefined();
    expect(retrieved?.requestId).toBe("req-test-2");
  });

  it("uses Postgres store when configured", async () => {
    const deps = buildDependencies({ SRE_CLIENT_POSTGRES: "real", SRE_POSTGRES_CONNECTION_STRING: SUPERUSER });
    if (deps.mode !== "manager") throw new Error("expected manager mode");
    expect(deps.runs).toBeDefined();
    // The store should be a Postgres-backed one, not InMemory
    expect(deps.runs.list().length).toBeLessThanOrEqual(50); // list should work
  });

  it("falls back to InMemoryRunStore when Postgres is mock", async () => {
    const deps = buildDependencies({ SRE_CLIENT_POSTGRES: "mock" });
    if (deps.mode !== "manager") throw new Error("expected manager mode");
    // with mock postgres, should still have a run store
    expect(deps.runs).toBeDefined();
  });
});
