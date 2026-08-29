import type { Evidence } from "@sre/evidence";

/**
 * The Sanitizer port — deterministic secret removal.
 *
 * It is REQUIRED, with no engine-supplied default, and that is the point: a
 * default would have to be either a no-op (silently disabling redaction on every
 * host that forgot to pass one) or a second pattern set that could disagree with
 * the host's. Making it a required dependency means an engine that redacts
 * nothing cannot be constructed.
 *
 * Everything untrusted crosses this boundary before it reaches model context or
 * a returned result: tool payloads, raw excerpts and model-authored summaries.
 */
export interface Sanitizer {
  /** Redact free text. `categories` names what was removed, never what was found. */
  text(input: string): { value: string; categories: string[] };
  /** Redact an evidence item in place of its payload and excerpt. */
  evidence(input: Evidence): Evidence;
}
