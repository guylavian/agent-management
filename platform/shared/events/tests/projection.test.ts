import { describe, expect, it } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import { assertSafeMetadata, parseEvent, UnsafeEventMetadataError, type ExecutionEvent } from "../src/event.ts";
import { eventId, projectStream } from "../src/projection.ts";
import { DisabledEventStore, MockEventStore } from "../src/store.ts";

/**
 * THE GENERIC EVENT LAYER, AND THE TWO THINGS IT MUST NEVER BECOME.
 *
 * It must never become a workflow — partial, repeated and out-of-order facts
 * are ordinary, and no transition is required or forbidden.
 *
 * It must never become authority — a projection over history cannot know
 * whether something is permitted NOW, so it has nowhere to say so.
 */
const KIND = "management-request";
const STREAM = "req-1";

function event(type: string, overrides: Partial<ExecutionEvent> = {}): ExecutionEvent {
  return parseEvent({
    eventId: overrides.eventId ?? eventId(KIND, STREAM, type),
    streamKind: KIND,
    streamId: STREAM,
    occurredAt: "2026-01-01T00:00:00.000Z",
    source: "management-api",
    type,
    outcome: "ok",
    metadata: {},
    ...overrides,
  });
}

describe("a projection is deterministic whatever order facts arrive in", () => {
  const facts = [
    event("REQUEST_CREATED", { occurredAt: "2026-01-01T00:00:01.000Z" }),
    event("PR_OPENED", { occurredAt: "2026-01-01T00:00:02.000Z" }),
    event("PR_MERGED", { occurredAt: "2026-01-01T00:00:03.000Z" }),
    event("ACTIVATION_OBSERVED", { occurredAt: "2026-01-01T00:00:04.000Z", source: "reconciler" }),
  ];

  it("reads the same shuffled as it does in order", () => {
    /*
     * Observers are independent and unsynchronised: the reconciler and the
     * management API both append, and a slow writer can land a fact after a
     * later one. None of that may change what an operator sees.
     */
    const ordered = projectStream(KIND, STREAM, facts);
    const shuffled = projectStream(KIND, STREAM, [facts[3], facts[0], facts[2], facts[1]] as ExecutionEvent[]);
    expect(JSON.stringify(shuffled.timeline)).toBe(JSON.stringify(ordered.timeline));
    expect(shuffled.outcome).toBe(ordered.outcome);
  });

  it("collapses a duplicated eventId to one entry", () => {
    // the store is idempotent, but a caller may assemble a list from more than
    // one query, and a human reading a timeline must not see the fact twice
    const projection = projectStream(KIND, STREAM, [...facts, facts[1] as ExecutionEvent]);
    expect(projection.timeline).toHaveLength(facts.length);
  });

  it("breaks a same-instant tie stably, by id rather than by arrival", () => {
    // two observers legitimately stamp the same millisecond; an unstable
    // tiebreak would make the timeline flicker between reads
    const at = "2026-02-02T00:00:00.000Z";
    const a = event("A", { eventId: "aaa", occurredAt: at });
    const b = event("B", { eventId: "bbb", occurredAt: at });
    expect(projectStream(KIND, STREAM, [b, a]).timeline.map((item) => item.eventId)).toEqual(["aaa", "bbb"]);
    expect(projectStream(KIND, STREAM, [a, b]).timeline.map((item) => item.eventId)).toEqual(["aaa", "bbb"]);
  });

  it("ignores facts belonging to another stream", () => {
    // cross-stream leakage would attribute one request's progress to another
    const other = event("PR_OPENED", { eventId: "other", streamId: "req-2" });
    const otherKind = event("PR_OPENED", { eventId: "other-kind", streamKind: "agent-run" });
    const projection = projectStream(KIND, STREAM, [...facts, other, otherKind]);
    expect(projection.timeline.map((item) => item.eventId)).not.toContain("other");
    expect(projection.timeline.map((item) => item.eventId)).not.toContain("other-kind");
  });
});

describe("the outcome describes the STREAM, never what it is permitted to do", () => {
  it("has nowhere to express authority", () => {
    /*
     * The load-bearing property. A projection over history cannot know whether
     * a suspension happened a second ago, whether Git narrowed the envelope, or
     * whether an attestation expired — so it must not have a field that looks
     * like an answer to any of those. `ACTIVE_OBSERVED` in a timeline means "it
     * was once observed active" and nothing more.
     */
    const projection = projectStream(KIND, STREAM, [event("ACTIVE_OBSERVED")]);
    for (const key of Object.keys(projection)) {
      expect(key, `a projection must not carry ${key}`).not.toMatch(/routab|permit|authori|enabled/iu);
    }
  });

  it("is pending when nothing has been observed at all", () => {
    // no observation is not the same as nothing having happened
    expect(projectStream(KIND, STREAM, []).outcome).toBe("pending");
  });

  it("is pending while anything is still in flight", () => {
    expect(projectStream(KIND, STREAM, [event("A"), event("B", { outcome: "pending" })]).outcome).toBe("pending");
  });

  it("is failed when the last word on any type is a failure", () => {
    expect(projectStream(KIND, STREAM, [event("A"), event("B", { outcome: "failed" })]).outcome).toBe("failed");
  });

  it("lets a later observation supersede an earlier one of the same type", () => {
    // a retry that failed and then succeeded is a success
    const failed = event("PR_OPENED", { eventId: "1", occurredAt: "2026-01-01T00:00:01.000Z", outcome: "failed" });
    const succeeded = event("PR_OPENED", { eventId: "2", occurredAt: "2026-01-01T00:00:02.000Z", outcome: "ok" });
    expect(projectStream(KIND, STREAM, [failed, succeeded]).outcome).toBe("ok");
    // and the reverse: one that succeeded and then failed is a failure
    const regressed = event("PR_OPENED", { eventId: "3", occurredAt: "2026-01-01T00:00:03.000Z", outcome: "failed" });
    expect(projectStream(KIND, STREAM, [failed, succeeded, regressed]).outcome).toBe("failed");
  });

  it("keeps the whole history even when only the last word counts", () => {
    // the reason to keep a log rather than a status column
    const projection = projectStream(KIND, STREAM, [
      event("PR_OPENED", { eventId: "1", occurredAt: "2026-01-01T00:00:01.000Z", outcome: "failed" }),
      event("PR_OPENED", { eventId: "2", occurredAt: "2026-01-01T00:00:02.000Z", outcome: "ok" }),
    ]);
    expect(projection.timeline).toHaveLength(2);
    expect(projection.latest.PR_OPENED?.eventId).toBe("2");
  });

  it("reports every observer that contributed", () => {
    const projection = projectStream(KIND, STREAM, [event("A"), event("B", { source: "reconciler" })]);
    expect(projection.sources).toEqual(["management-api", "reconciler"]);
  });
});

describe("metadata carries facts, never payloads", () => {
  it.each(["token", "secret", "password", "apiKey", "credential", "authorization", "sessionId", "reasoning"])(
    "refuses a key named %s",
    (key) => {
      expect(() => assertSafeMetadata({ [key]: "x" })).toThrow(UnsafeEventMetadataError);
    },
  );

  it("refuses a nested value, because that is where a payload hides", () => {
    expect(() => assertSafeMetadata({ detail: { nested: true } })).toThrow(/not a scalar/u);
  });

  it("refuses credential-shaped values even under an innocuous key", async () => {
    // the key check catches carelessness; this catches someone renaming the key
    // to get past it
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const pem = await exportPKCS8(privateKey);
    expect(() => assertSafeMetadata({ note: pem })).toThrow(/credential/u);
    expect(() => assertSafeMetadata({ note: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJl" })).toThrow(/credential/u);
    expect(() => assertSafeMetadata({ note: "Bearer sk-abcdefghijklmnopqrstuvwxyz" })).toThrow(/credential/u);
  });

  it("accepts ordinary scalars", () => {
    expect(() => assertSafeMetadata({ agentId: "kafka", pullRequest: 12, merged: true })).not.toThrow();
  });

  it("enforces this at APPEND, not at read", async () => {
    // an append-only table cannot take it back, and redacting on the way out
    // still leaves the value in the table and in every backup of it
    const store = new MockEventStore();
    await expect(store.append({ ...event("A"), metadata: { token: "abc" } })).rejects.toThrow(UnsafeEventMetadataError);
    expect(await store.list(KIND, STREAM)).toEqual([]);
  });
});

describe("event ids make a retry free", () => {
  it("is stable for the same observation", () => {
    expect(eventId(KIND, STREAM, "PR_OPENED")).toBe(eventId(KIND, STREAM, "PR_OPENED"));
  });

  it("separates observations of the same type that are genuinely different", () => {
    expect(eventId(KIND, STREAM, "RUNTIME_ATTESTED", "gen-11")).not.toBe(eventId(KIND, STREAM, "RUNTIME_ATTESTED", "gen-12"));
  });

  it("is injective: no two different observations can collide", () => {
    /*
     * A plain join is ambiguous. `("a", "b:c", "D")` and `("a:b", "c", "D")`
     * both render as `a:b:c:D`, so one of the two observations would be
     * silently dropped as a duplicate of the other — and silently is the worst
     * way to lose an audit record.
     */
    expect(eventId("a", "b:c", "D")).not.toBe(eventId("a:b", "c", "D"));
    expect(eventId(KIND, STREAM, "PR_OPENED")).not.toBe(eventId(KIND, `${STREAM}:PR`, "OPENED"));
    // and it still distinguishes a present discriminator from an absent one
    expect(eventId(KIND, STREAM, "X")).not.toBe(eventId(KIND, STREAM, "X", ""));
  });
});

describe("the store is append-only and idempotent", () => {
  it("reports a repeat as not-written rather than failing", async () => {
    const store = new MockEventStore();
    expect(await store.append(event("REQUEST_CREATED"))).toBe(true);
    // the expected answer for a retry; treating it as an error would make every
    // at-least-once delivery look like a fault
    expect(await store.append(event("REQUEST_CREATED"))).toBe(false);
    expect(await store.list(KIND, STREAM)).toHaveLength(1);
  });

  it("keeps streams of different kinds apart", async () => {
    const store = new MockEventStore();
    await store.append(event("A"));
    await store.append(event("A", { eventId: "run", streamKind: "agent-run" }));
    expect(await store.list(KIND, STREAM)).toHaveLength(1);
    expect(await store.list("agent-run", STREAM)).toHaveLength(1);
  });

  it("lists recent streams newest first", async () => {
    const store = new MockEventStore();
    await store.append(event("A", { eventId: "1", streamId: "old" }));
    await store.append(event("A", { eventId: "2", streamId: "new" }));
    expect(await store.recentStreams(KIND, 10)).toEqual(["new", "old"]);
  });

  it("costs observability and never correctness when disabled", async () => {
    // nothing derives authority from an event, so a deployment with no log
    // still routes exactly as it should — it just cannot explain itself
    const store = new DisabledEventStore();
    expect(await store.append(event("A"))).toBe(false);
    expect(await store.list(KIND, STREAM)).toEqual([]);
  });
});

describe("the generic layer knows nothing about Agents", () => {
  it("names no Agent concept anywhere in its source", async () => {
    /*
     * The door this keeps open: the same store must later carry SSO enrolments
     * or Kafka topic provisioning without learning a second domain. One import
     * of an Agent type closes it.
     */
    const { readFileSync, readdirSync } = await import("node:fs");
    for (const file of readdirSync("shared/events/src")) {
      const source = readFileSync(`shared/events/src/${file}`, "utf8");
      expect(source, `${file} imports an Agent type`).not.toMatch(/from "@sre\/(config|agent-schema|orchestrator|evidence)"/u);
      // `agent` may appear in prose; a TYPE named for one may not
      expect(source, `${file} declares an Agent-shaped type`).not.toMatch(/\b(AgentConfig|AgentDocument|SpecialistAgentConfig|AgentCatalog)\b/u);
    }
  });
});
