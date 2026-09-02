import { createHash } from "node:crypto";
import type { ExecutionEvent, EventOutcome } from "./event.ts";

/**
 * A DETERMINISTIC READING OF ONE STREAM.
 *
 * Given the same set of events in any order, this produces the same result.
 * That matters because observers are independent and unsynchronised: the
 * reconciler and the management API both append, retries repeat, and a slow
 * writer can land a fact after a later one. None of that may change what an
 * operator sees.
 *
 * ═══ WHAT THIS DELIBERATELY DOES NOT DO ═══
 *
 * It does not decide whether anything is permitted. There is no field here for
 * routability, and none may be added: a projection over history cannot know
 * whether a suspension happened a second ago, whether Git narrowed the
 * envelope, or whether an attestation has expired. `ACTIVE_OBSERVED` in this
 * timeline means "it was once observed active" and nothing more.
 *
 * The reader that needs the live answer asks the operational plane for it, on
 * every read. See `docs/architecture/hybrid-control-plane.md`.
 *
 * It is also NOT a state machine. No transition is required, forbidden or
 * ordered. Facts arrive partial, repeated and out of order, and all three are
 * ordinary.
 */

export interface StreamProjection {
  streamKind: string;
  streamId: string;
  /** every event, oldest first, duplicates collapsed */
  timeline: ExecutionEvent[];
  /** the LAST observation of each type, by the ordering below */
  latest: Record<string, ExecutionEvent>;
  firstObservedAt?: string;
  lastObservedAt?: string;
  /**
   * How the STREAM is going — not how anything it describes is permitted.
   *
   * `failed` if any observation failed and nothing later superseded it,
   * `pending` while anything is still in flight, `ok` when every observation
   * settled successfully. A stream with no events at all is `pending`: nothing
   * has been observed, which is not the same as nothing having happened.
   */
  outcome: EventOutcome;
  /** every distinct observer that contributed, sorted */
  sources: string[];
}

/**
 * Total order over events, so two readers never disagree.
 *
 * `occurredAt` first because that is when the fact happened. `eventId` breaks
 * ties, because two observers can legitimately stamp the same millisecond and
 * an unstable tiebreak would make the timeline flicker between reads.
 */
function compare(left: ExecutionEvent, right: ExecutionEvent): number {
  if (left.occurredAt !== right.occurredAt) return left.occurredAt < right.occurredAt ? -1 : 1;
  return left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0;
}

export function projectStream(streamKind: string, streamId: string, events: readonly ExecutionEvent[]): StreamProjection {
  /*
   * Collapse by `eventId` BEFORE ordering. The store is idempotent, but a
   * caller may hand us a list assembled from more than one query, and a
   * duplicate would otherwise appear twice in a timeline a human is reading.
   */
  const unique = new Map<string, ExecutionEvent>();
  for (const event of events) {
    if (event.streamKind !== streamKind || event.streamId !== streamId) continue;
    unique.set(event.eventId, event);
  }
  const timeline = [...unique.values()].sort(compare);

  const latest: Record<string, ExecutionEvent> = {};
  for (const event of timeline) latest[event.type] = event;

  /*
   * A LATER observation of the same type supersedes an earlier one. A retry
   * that failed and then succeeded is a success; one that succeeded and then
   * failed is a failure. Only the last word of each type counts, which is why
   * `latest` is what this reads rather than the whole timeline.
   */
  const verdicts = Object.values(latest).map((event) => event.outcome);
  const outcome: EventOutcome = verdicts.includes("failed")
    ? "failed"
    : verdicts.length === 0 || verdicts.includes("pending")
      ? "pending"
      : "ok";

  return {
    streamKind,
    streamId,
    timeline,
    latest,
    ...(timeline[0] ? { firstObservedAt: timeline[0].occurredAt } : {}),
    ...(timeline.at(-1) ? { lastObservedAt: (timeline.at(-1) as ExecutionEvent).occurredAt } : {}),
    outcome,
    sources: [...new Set(timeline.map((event) => event.source))].sort(),
  };
}

/**
 * Build the idempotency key for an observation.
 *
 * Derived from WHAT was observed rather than from when, so a retry of the same
 * observation collapses instead of appending a second copy. `discriminator`
 * separates observations of the same type that are genuinely different — an
 * attestation round, say — and is omitted when the type happens at most once
 * per stream.
 */
export function eventId(streamKind: string, streamId: string, type: string, discriminator?: string): string {
  /*
   * LENGTH-PREFIXED, because a plain join is ambiguous: `("a", "b:c", "D")` and
   * `("a:b", "c", "D")` both render as `a:b:c:D`, so one of the two
   * observations would be silently dropped as a duplicate of the other. A
   * length prefix makes the encoding injective, whatever the parts contain.
   */
  const composed = [streamKind, streamId, type, ...(discriminator === undefined ? [] : [discriminator])]
    .map((part) => `${part.length}:${part}`)
    .join("");
  /*
   * The schema caps an id at 200 characters, and a long stream id plus a long
   * discriminator can exceed that — which would reject the append rather than
   * truncate it, losing the observation entirely. Digesting a long id keeps it
   * both injective in practice and within the bound.
   */
  return composed.length <= MAX_EVENT_ID ? composed : `sha256:${createHash("sha256").update(composed).digest("hex")}`;
}

/** Comfortably inside the schema's 200-character cap, digest included. */
const MAX_EVENT_ID = 180;
