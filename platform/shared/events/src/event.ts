import { z } from "zod";

/**
 * A GENERIC, APPEND-ONLY EXECUTION EVENT.
 *
 * One fact that was observed about one stream, by one observer, at one moment.
 *
 * NOTHING HERE KNOWS WHAT AN AGENT IS. `streamId` and `streamKind` are opaque
 * strings, and `type` is free vocabulary. That is deliberate and load-bearing:
 * the same store must later carry SSO enrolments, Kafka topic provisioning or
 * any other GitOps request without this package learning a second domain. The
 * moment an Agent type appears in this file, that door closes.
 *
 * ═══ EVENTS ARE NOT AUTHORITY ═══
 *
 * An event says "this was observed". It never says "this is permitted", and
 * nothing may derive permission from one. A stream that once recorded
 * `ACTIVE_OBSERVED` proves only that something was once active — the question
 * of whether it may route RIGHT NOW is answered by the operational plane, live,
 * every time it is asked.
 *
 * The failure this rules out: a stale success event outliving the state it
 * described, and a reader treating history as a verdict.
 */

/**
 * Metadata may hold SCALARS ONLY, and is capped.
 *
 * Events are read by humans in a console and shipped to telemetry, so the one
 * thing they must never carry is a payload: no token, no credential, no model
 * reasoning, no raw tool output, no request body. A nested object is where such
 * a thing hides, so nesting is not representable rather than discouraged.
 *
 * `assertSafeMetadata` is the enforcement; this schema is the shape.
 */
export const eventMetadataSchema = z.record(
  z.string().min(1).max(64),
  z.union([z.string().max(512), z.number(), z.boolean()]),
);

export type EventMetadata = z.infer<typeof eventMetadataSchema>;

/**
 * Did the observed thing succeed, fail, or is it still in flight?
 *
 * Deliberately NOT a workflow state. It qualifies one observation; it does not
 * place the stream in a phase, and no transition table governs which may follow
 * which. Partial, repeated and out-of-order observations are all legal.
 */
export const eventOutcomeSchema = z.enum(["pending", "ok", "failed"]);
export type EventOutcome = z.infer<typeof eventOutcomeSchema>;

export const executionEventSchema = z
  .object({
    /**
     * Stable and CALLER-SUPPLIED, because it is the idempotency key.
     *
     * A retry that regenerates this id would append a duplicate; a retry that
     * reuses it is a no-op. Deriving it from what is being observed — stream,
     * type and the thing observed — makes retries free.
     */
    eventId: z.string().min(1).max(200),
    /** opaque: a request id, a run id, anything the caller correlates by */
    streamId: z.string().min(1).max(200),
    /** opaque: what KIND of thing the stream is, e.g. "management-request" */
    streamKind: z.string().min(1).max(64),
    /** when the fact was OBSERVED, not when it was written */
    occurredAt: z.string().min(1),
    /** which observer saw it, e.g. "management-api", "reconciler" */
    source: z.string().min(1).max(64),
    /** who caused it, when a human did; absent for machine observations */
    actor: z.string().min(1).max(200).optional(),
    /** free vocabulary, e.g. PR_OPENED — never matched against a state machine */
    type: z.string().min(1).max(64),
    outcome: eventOutcomeSchema,
    metadata: eventMetadataSchema.default({}),
  })
  .strict();

export type ExecutionEvent = z.infer<typeof executionEventSchema>;

/** Keys whose VALUE must never be recorded, however it is spelled. */
const FORBIDDEN_KEY = /secret|token|password|credential|apikey|api_key|authorization|bearer|private[_-]?key|cookie|session|reasoning|chain[_-]?of[_-]?thought/iu;

/** Values that look like credential material whatever the key is called. */
const FORBIDDEN_VALUE = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/iu,
  // a JWT: three base64url segments
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
  /*
   * Provider tokens under an innocuous key. The common case is not malice: it
   * is a provider's error message quoted verbatim into a field called `reason`,
   * carrying the very token the request was rejected for.
   */
  /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/u,
  /\bsk-[A-Za-z0-9]{16,}/u,
  /\bAKIA[0-9A-Z]{12,}/u,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/u,
];

export class UnsafeEventMetadataError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`unsafe event metadata: ${reason}`);
    this.name = "UnsafeEventMetadataError";
    this.reason = reason;
  }
}

/**
 * Refuse metadata that could carry a payload or a credential.
 *
 * Enforced at APPEND, not at read. Once written, an append-only store cannot
 * take it back — and a redaction applied on the way out still leaves the value
 * sitting in a table and in every backup of it.
 *
 * The key check catches the careless case (`{ token: ... }`); the value check
 * catches the case where someone renamed the key to get past it.
 */
export function assertSafeMetadata(metadata: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(metadata)) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new UnsafeEventMetadataError(`"${key}" names credential or reasoning material`);
    }
    if (value !== null && typeof value === "object") {
      // nesting is where a payload hides; the schema rejects it too, and this
      // says why rather than reporting a type mismatch
      throw new UnsafeEventMetadataError(`"${key}" is not a scalar; events carry facts, never payloads`);
    }
    if (typeof value === "string") {
      for (const pattern of FORBIDDEN_VALUE) {
        if (pattern.test(value)) throw new UnsafeEventMetadataError(`"${key}" holds something shaped like a credential`);
      }
    }
  }
}

/** Validate and normalise one event, refusing anything unsafe. */
export function parseEvent(candidate: unknown): ExecutionEvent {
  const event = executionEventSchema.parse(candidate);
  assertSafeMetadata(event.metadata);
  return event;
}

/**
 * Append-only, idempotent by `eventId`.
 *
 * There is no update and no delete. A correction is a new event, so the record
 * of what was believed at the time survives — which is the entire reason to
 * keep a log rather than a status column.
 */
export interface EventStore {
  readonly mode: "mock" | "real" | "disabled";
  /**
   * Appends unless `eventId` is already present.
   *
   * Returns whether it was written. `false` means "already recorded", which is
   * the expected answer for a retry and must not be treated as an error.
   */
  append(event: ExecutionEvent): Promise<boolean>;
  /** every event on one stream, oldest first */
  list(streamKind: string, streamId: string): Promise<ExecutionEvent[]>;
  /** the most recent streams of a kind, newest activity first */
  recentStreams(streamKind: string, limit: number): Promise<string[]>;
  close(): Promise<void>;
}
