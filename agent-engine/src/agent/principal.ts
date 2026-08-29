/**
 * The delegated caller on whose behalf the Agent investigates, and the
 * short-lived credential the Agent presents downstream on their behalf.
 *
 * The engine treats a credential as an opaque bearer value plus the audience it
 * is bound to. It never parses it, never logs it, and never places it in a span
 * attribute or in model context.
 */

export interface Principal {
  subject: string;
  roles: string[];
  groups?: string[];
  requestId: string;
  sessionId?: string;
}

export interface ToolCredential {
  /** opaque bearer value — never logged, never traced, never shown to the model */
  token: string;
  /** the single resource this credential is bound to; checked before every call */
  audience: string;
  /** hash of the delegated subject, for audit correlation without the subject */
  subjectHash?: string;
  /** workload client that obtained it; audit needs both actors */
  workloadClientId?: string;
}
