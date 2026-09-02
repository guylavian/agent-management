import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockEventStore, PostgresEventStore, projectStream, eventId, parseEvent } from "@sre/events";

/**
 * DURABLE REQUESTS AND THE APPEND-ONLY LOG, AGAINST A REAL POSTGRESQL.
 *
 * Every other test of this layer runs in memory, which proves the rules are
 * implemented but not that the database enforces them. The append-only trigger,
 * the idempotency conflict and the survival of a process restart are all things
 * only a real server can demonstrate.
 *
 * Skipped loudly without `SRE_TEST_POSTGRES_URL`; see
 * `npm run test:postgres` for the throwaway instance.
 */
const SUPERUSER = process.env.SRE_TEST_POSTGRES_URL;
const KIND = "management-request";
const describeOrSkip = SUPERUSER === undefined ? describe.skip : describe;

function event(streamId: string, type: string, overrides: Record<string, unknown> = {}) {
  return parseEvent({
    eventId: eventId(KIND, streamId, type),
    streamKind: KIND,
    streamId,
    occurredAt: "2026-03-01T00:00:00.000Z",
    source: "management-api",
    type,
    outcome: "ok",
    metadata: {},
    ...overrides,
  });
}

describeOrSkip("the event log against a real PostgreSQL", () => {
  let admin: Pool;
  let store: PostgresEventStore;

  beforeAll(async () => {
    admin = new Pool({ connectionString: SUPERUSER });
    for (const file of ["003_execution_events.sql", "004_management_requests.sql"]) {
      await admin.query(readFileSync(`../deploy/runtime/postgres/${file}`, "utf8"));
    }
    // TRUNCATE, not DELETE: the append-only trigger refuses per-row deletion,
    // which is the point of it. Truncation is a table-level operation only the
    // owner has, and the owner is outside this boundary by design.
    await admin.query("TRUNCATE sre_execution_event, sre_management_request");
    store = new PostgresEventStore(SUPERUSER as string);
  }, 60_000);

  afterAll(async () => {
    await store?.close();
    await admin?.end();
  });

  it("survives the store being recreated, which is what a restart is", async () => {
    await store.append(event("req-1", "REQUEST_CREATED"));
    await store.append(event("req-1", "PR_OPENED", { occurredAt: "2026-03-01T00:00:01.000Z" }));

    // a NEW store object over the same database: no shared memory, no cache
    const reopened = new PostgresEventStore(SUPERUSER as string);
    try {
      const events = await reopened.list(KIND, "req-1");
      expect(events.map((item) => item.type)).toEqual(["REQUEST_CREATED", "PR_OPENED"]);
    } finally {
      await reopened.close();
    }
  });

  it("is idempotent: a retry reports not-written rather than duplicating", async () => {
    // at-least-once delivery is the normal case for an observer, so a repeat
    // must be free rather than an error
    expect(await store.append(event("req-2", "REQUEST_CREATED"))).toBe(true);
    expect(await store.append(event("req-2", "REQUEST_CREATED"))).toBe(false);
    expect(await store.list(KIND, "req-2")).toHaveLength(1);
  });

  it("refuses to let history be rewritten or erased", async () => {
    /*
     * The writer role holds no UPDATE and no DELETE, so this trigger ordinarily
     * never fires. It exists for the grant made by hand during an incident: a
     * log that can be rewritten is not a log.
     */
    await store.append(event("req-3", "REQUEST_CREATED"));
    await expect(admin.query("UPDATE sre_execution_event SET outcome = 'failed' WHERE stream_id = 'req-3'"))
      .rejects.toThrow(/append-only/u);
    await expect(admin.query("DELETE FROM sre_execution_event WHERE stream_id = 'req-3'"))
      .rejects.toThrow(/append-only/u);
  });

  it("keeps streams and kinds isolated", async () => {
    await store.append(event("req-4", "REQUEST_CREATED"));
    await store.append({ ...event("req-4", "REQUEST_CREATED"), eventId: "other-kind", streamKind: "agent-run" });
    // a request's timeline must never absorb another stream's facts
    expect(await store.list(KIND, "req-4")).toHaveLength(1);
    expect(await store.list("agent-run", "req-4")).toHaveLength(1);
  });

  it("projects out-of-order facts into a stable timeline", async () => {
    // observers are independent; a slow writer lands a fact after a later one
    await store.append(event("req-5", "PR_MERGED", { occurredAt: "2026-03-01T00:00:03.000Z" }));
    await store.append(event("req-5", "REQUEST_CREATED", { occurredAt: "2026-03-01T00:00:01.000Z" }));
    await store.append(event("req-5", "PR_OPENED", { occurredAt: "2026-03-01T00:00:02.000Z" }));

    const projection = projectStream(KIND, "req-5", await store.list(KIND, "req-5"));
    expect(projection.timeline.map((item: { type: string }) => item.type)).toEqual(["REQUEST_CREATED", "PR_OPENED", "PR_MERGED"]);
    expect(projection.outcome).toBe("ok");
  });

  it("cannot be talked into carrying credential material", async () => {
    // enforced at APPEND: an append-only table cannot take it back, and
    // redacting on read still leaves the value in every backup
    await expect(store.append({ ...event("req-6", "PR_OPENED"), metadata: { token: "abc" } }))
      .rejects.toThrow(/unsafe event metadata/u);
    expect(await store.list(KIND, "req-6")).toEqual([]);
  });

  it("agrees with the in-memory store on every rule", async () => {
    // the mock is what most tests run against; a divergence would make those
    // tests a statement about the mock rather than about the system
    const mock = new MockEventStore();
    expect(await mock.append(event("req-7", "REQUEST_CREATED"))).toBe(true);
    expect(await mock.append(event("req-7", "REQUEST_CREATED"))).toBe(false);
    await expect(mock.append({ ...event("req-7", "X"), metadata: { secret: "s" } })).rejects.toThrow(/unsafe/u);

    expect(await store.append(event("req-7", "REQUEST_CREATED"))).toBe(true);
    expect(await store.append(event("req-7", "REQUEST_CREATED"))).toBe(false);
  });
});

/**
 * THE PORTAL'S DURABLE REQUEST STORE, against the same database.
 *
 * The plugin cannot be imported here — it is a separate Yarn workspace — so
 * this exercises the SQL contract the two planes actually share: the request
 * row, the event stream, and the rules the migration enforces on both.
 */
describeOrSkip("management requests survive a restart", () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: SUPERUSER });
    for (const file of ["003_execution_events.sql", "004_management_requests.sql"]) {
      await admin.query(readFileSync(`../deploy/runtime/postgres/${file}`, "utf8"));
    }
    await admin.query("TRUNCATE sre_execution_event, sre_management_request");
  }, 60_000);

  afterAll(async () => { await admin?.end(); });

  it("keeps the request and its timeline when the process goes away", async () => {
    await admin.query(
      `INSERT INTO sre_management_request(request_id, agent_id, environment, type, requested_by, created_at, branch)
       VALUES ('r1','kafka','production','create','alice', NOW(), 'agent/add-kafka')`,
    );
    await admin.query(
      `INSERT INTO sre_execution_event(event_id, stream_kind, stream_id, occurred_at, source, type, outcome, metadata)
       VALUES ('production/e1','management-request','production/r1', NOW(), 'management-api','REQUEST_CREATED','ok','{}')`,
    );

    // a completely fresh connection stands in for the restarted backend
    const reopened = new Pool({ connectionString: SUPERUSER });
    try {
      const request = await reopened.query("SELECT agent_id FROM sre_management_request WHERE request_id = 'r1'");
      const events = await reopened.query("SELECT type FROM sre_execution_event WHERE stream_id = 'production/r1'");
      expect(request.rows[0]?.agent_id).toBe("kafka");
      expect(events.rows.map((row: { type: string }) => row.type)).toEqual(["REQUEST_CREATED"]);
    } finally {
      await reopened.end();
    }
  });

  it("refuses to reattribute a request to another Agent or environment", async () => {
    /*
     * The request id is the correlation key every event joins on. Moving the
     * agent or the environment would reattribute the change and its whole
     * timeline while the event stream carried on pointing at the original.
     */
    await expect(admin.query("UPDATE sre_management_request SET agent_id = 'keycloak' WHERE request_id = 'r1'"))
      .rejects.toThrow(/immutable/u);
    await expect(admin.query("UPDATE sre_management_request SET environment = 'dr' WHERE request_id = 'r1'"))
      .rejects.toThrow(/immutable/u);
  });

  it("keeps two environments' streams apart even when the request id is the same", async () => {
    // the event table is generic and carries no environment column, so the
    // stream id is environment-qualified; otherwise one estate's observation
    // would be dropped as a duplicate of the other's
    await admin.query(
      `INSERT INTO sre_execution_event(event_id, stream_kind, stream_id, occurred_at, source, type, outcome, metadata)
       VALUES ('dr/e1','management-request','dr/r1', NOW(), 'management-api','REQUEST_CREATED','ok','{}')`,
    );
    const production = await admin.query("SELECT 1 FROM sre_execution_event WHERE stream_id = 'production/r1'");
    const dr = await admin.query("SELECT 1 FROM sre_execution_event WHERE stream_id = 'dr/r1'");
    expect(production.rowCount).toBe(1);
    expect(dr.rowCount).toBe(1);
  });

  it("keeps the same request id in two environments as two distinct rows", async () => {
    /*
     * A single-column key let a second estate's insert be silently ignored,
     * leaving its event stream orphaned with no row to explain it. The key is
     * composite, matching the environment-qualified stream id.
     */
    await admin.query(
      `INSERT INTO sre_management_request(request_id, agent_id, environment, type, requested_by, created_at, branch)
       VALUES ('r1','kafka','dr','create','alice', NOW(), 'agent/add-kafka')
       ON CONFLICT (request_id, environment) DO NOTHING`,
    );
    const rows = await admin.query("SELECT environment FROM sre_management_request WHERE request_id = 'r1' ORDER BY environment");
    expect(rows.rows.map((row: { environment: string }) => row.environment)).toEqual(["dr", "production"]);
  });

  it("allows the mutable columns while refusing the identity ones", async () => {
    // a pull request number arrives after the row exists, so the record must
    // stay writable where it legitimately changes
    await admin.query("UPDATE sre_management_request SET pull_request_number = 7 WHERE request_id = 'r1'");
    const row = await admin.query("SELECT pull_request_number FROM sre_management_request WHERE request_id = 'r1'");
    expect(row.rows[0]?.pull_request_number).toBe(7);
  });
});
