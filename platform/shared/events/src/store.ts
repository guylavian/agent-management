import { Pool } from "pg";
import { parseEvent, type EventStore, type ExecutionEvent } from "./event.ts";

/**
 * Storage for the append-only event log.
 *
 * Three implementations, the same pattern as every other store here: a
 * `disabled` one for deployments that have not wired persistence, a `mock` one
 * that enforces exactly the same rules in memory, and the PostgreSQL one.
 *
 * All three run `parseEvent` before accepting anything, so a test exercises the
 * same validation production does. Metadata that could carry a token, a raw
 * tool payload or model reasoning is refused at APPEND — an append-only table
 * cannot take it back afterwards, and redacting on read still leaves the value
 * in the table and in every backup of it.
 */

/**
 * No event store wired.
 *
 * Losing this costs OBSERVABILITY, never correctness: nothing derives authority
 * from an event, so a deployment with no log still routes exactly as it should.
 * It simply cannot explain itself afterwards.
 */
export class DisabledEventStore implements EventStore {
  readonly mode = "disabled" as const;
  async append(_event: ExecutionEvent): Promise<boolean> { return false; }
  async list(_streamKind: string, _streamId: string): Promise<ExecutionEvent[]> { return []; }
  async recentStreams(_streamKind: string, _limit: number): Promise<string[]> { return []; }
  async close(): Promise<void> {}
}

export class MockEventStore implements EventStore {
  readonly mode = "mock" as const;
  readonly #events = new Map<string, ExecutionEvent>();
  /** insertion order per stream, so `recentStreams` can answer without clocks */
  #sequence = 0;
  readonly #seenAt = new Map<string, number>();

  async append(event: ExecutionEvent): Promise<boolean> {
    const parsed = parseEvent(event);
    // idempotent: a retry reusing the id is a no-op, and reporting `false` is
    // the expected answer for one rather than an error
    if (this.#events.has(parsed.eventId)) return false;
    this.#events.set(parsed.eventId, parsed);
    this.#sequence += 1;
    this.#seenAt.set(`${parsed.streamKind}:${parsed.streamId}`, this.#sequence);
    return true;
  }

  async list(streamKind: string, streamId: string): Promise<ExecutionEvent[]> {
    return [...this.#events.values()]
      .filter((event) => event.streamKind === streamKind && event.streamId === streamId)
      .sort((left, right) => (left.occurredAt < right.occurredAt ? -1 : left.occurredAt > right.occurredAt ? 1 : left.eventId < right.eventId ? -1 : 1))
      .map((event) => structuredClone(event));
  }

  async recentStreams(streamKind: string, limit: number): Promise<string[]> {
    return [...this.#seenAt.entries()]
      .filter(([key]) => key.startsWith(`${streamKind}:`))
      .sort(([, left], [, right]) => right - left)
      .slice(0, limit)
      .map(([key]) => key.slice(streamKind.length + 1));
  }

  async close(): Promise<void> {}
}

interface EventRow {
  event_id: string;
  stream_kind: string;
  stream_id: string;
  occurred_at: Date;
  source: string;
  actor: string | null;
  type: string;
  outcome: string;
  metadata: Record<string, string | number | boolean>;
}

const COLUMNS = "event_id, stream_kind, stream_id, occurred_at, source, actor, type, outcome, metadata";

export class PostgresEventStore implements EventStore {
  readonly mode = "real" as const;
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 6 });
  }

  async append(event: ExecutionEvent): Promise<boolean> {
    // validated BEFORE the insert: the table is append-only, so anything that
    // reaches it is there for good
    const parsed = parseEvent(event);
    const result = await this.#pool.query(
      `INSERT INTO sre_execution_event(${COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (event_id) DO NOTHING`,
      [parsed.eventId, parsed.streamKind, parsed.streamId, parsed.occurredAt, parsed.source, parsed.actor ?? null, parsed.type, parsed.outcome, parsed.metadata],
    );
    // zero rows means the id was already present — a retry, not a failure
    return (result.rowCount ?? 0) > 0;
  }

  async list(streamKind: string, streamId: string): Promise<ExecutionEvent[]> {
    const result = await this.#pool.query<EventRow>(
      `SELECT ${COLUMNS} FROM sre_execution_event
        WHERE stream_kind = $1 AND stream_id = $2
        ORDER BY occurred_at, event_id`,
      [streamKind, streamId],
    );
    return result.rows.map(toEvent);
  }

  async recentStreams(streamKind: string, limit: number): Promise<string[]> {
    const result = await this.#pool.query<{ stream_id: string }>(
      `SELECT stream_id FROM sre_execution_event
        WHERE stream_kind = $1
        GROUP BY stream_id
        ORDER BY MAX(recorded_at) DESC
        LIMIT $2`,
      [streamKind, limit],
    );
    return result.rows.map((row) => row.stream_id);
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

function toEvent(row: EventRow): ExecutionEvent {
  return parseEvent({
    eventId: row.event_id,
    streamKind: row.stream_kind,
    streamId: row.stream_id,
    occurredAt: row.occurred_at.toISOString(),
    source: row.source,
    ...(row.actor === null ? {} : { actor: row.actor }),
    type: row.type,
    outcome: row.outcome,
    metadata: row.metadata,
  });
}
