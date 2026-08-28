import { Pool } from "pg";
import { z } from "zod";

export const boundedSessionContextSchema = z.object({
  sessionId: z.string().min(1),
  subject: z.string().min(1),
  entities: z.array(z.object({ alias: z.string(), canonical: z.string(), type: z.string() }).strict()).max(32),
  previousRequestId: z.string().optional(),
  expiresAt: z.string(),
}).strict();
export type BoundedSessionContext = z.infer<typeof boundedSessionContextSchema>;

export interface SessionStore {
  readonly mode: "mock" | "real" | "disabled";
  get(subject: string, sessionId: string): Promise<BoundedSessionContext | undefined>;
  put(context: BoundedSessionContext): Promise<void>;
  close(): Promise<void>;
}

/** Explicitly disables optional conversation persistence; it supplies no data. */
export class DisabledSessionStore implements SessionStore {
  readonly mode = "disabled" as const;
  async get(_subject: string, _sessionId: string): Promise<undefined> { return undefined; }
  async put(_context: BoundedSessionContext): Promise<void> {}
  async close(): Promise<void> {}
}

export class MockSessionStore implements SessionStore {
  readonly mode = "mock" as const;
  readonly #contexts = new Map<string, BoundedSessionContext>();
  async get(subject: string, sessionId: string): Promise<BoundedSessionContext | undefined> {
    const value = this.#contexts.get(`${subject}:${sessionId}`);
    if (value === undefined || Date.parse(value.expiresAt) <= Date.now()) return undefined;
    return structuredClone(value);
  }
  async put(context: BoundedSessionContext): Promise<void> {
    this.#contexts.set(`${context.subject}:${context.sessionId}`, structuredClone(boundedSessionContextSchema.parse(context)));
  }
  async close(): Promise<void> {}
}

export class PostgresSessionStore implements SessionStore {
  readonly mode = "real" as const;
  readonly #pool: Pool;
  constructor(connectionString: string) { this.#pool = new Pool({ connectionString, max: 10 }); }
  async get(subject: string, sessionId: string): Promise<BoundedSessionContext | undefined> {
    const result = await this.#pool.query<{ context: unknown }>(
      "SELECT context FROM sre_sessions WHERE subject = $1 AND session_id = $2 AND expires_at > NOW()",
      [subject, sessionId],
    );
    return result.rows[0] === undefined ? undefined : boundedSessionContextSchema.parse(result.rows[0].context);
  }
  async put(context: BoundedSessionContext): Promise<void> {
    const value = boundedSessionContextSchema.parse(context);
    await this.#pool.query(
      "INSERT INTO sre_sessions(subject, session_id, expires_at, context) VALUES($1,$2,$3,$4) ON CONFLICT(subject, session_id) DO UPDATE SET expires_at=EXCLUDED.expires_at, context=EXCLUDED.context",
      [value.subject, value.sessionId, value.expiresAt, value],
    );
  }
  async close(): Promise<void> { await this.#pool.end(); }
}
