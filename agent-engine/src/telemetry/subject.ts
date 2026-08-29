import { createHash } from "node:crypto";

/**
 * Traces carry `user.subject_hash`, never the subject. The engine hashes rather
 * than accepting a pre-hashed value so that no caller can arrange for a raw
 * subject to reach a span by passing it in the hash field.
 */
export function hashSubject(subject: string): string {
  return createHash("sha256").update(subject).digest("hex");
}
