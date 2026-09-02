import { Pool } from "pg";
import { z } from "zod";

/**
 * THE OPERATIONAL CONTROL PLANE for Agents.
 *
 * Git holds the approved envelope — identity, tool access, prompt, routing text,
 * environments, model, limits. This holds only what can NARROW that envelope,
 * plus attestations about the world.
 *
 * Read `docs/architecture/hybrid-control-plane.md` before changing anything
 * here. In particular:
 *
 *  - There is no field for access, capabilities, prompt, identity, model,
 *    environments or roles. That absence is the security property: no write can
 *    express a privilege increase because there is nowhere to put one.
 *  - Row existence IS the reviewed activation. Absent means never approved to
 *    run, which resolves to NOT routable. Only the reconciler creates rows.
 *  - Existence is necessary, never sufficient. The resolver conjoins it with
 *    the live Git envelope, so a row for an Agent Git no longer approves grants
 *    nothing.
 *  - Attestations carry the envelope generation and digest they were observed
 *    against, because a bare boolean is a resurrection path.
 */

/** What an Agent's operational row can say. Every field narrows or records. */
export const agentOperationalStateSchema = z
  .object({
    agentName: z.string().min(1),
    environment: z.string().min(1),
    /** the activation epoch; set once, by the reconciler */
    activatedAt: z.string(),
    suspended: z.boolean(),
    suspendedReason: z.string().optional(),
    suspendedBy: z.string().optional(),
    suspendedAt: z.string().optional(),
    /** clamped to the approved overlay ON READ, never trusted as an upper bound */
    replicaCeiling: z.number().int().min(0),
    /** a subset of the envelope's environments, subtracted; can never add one */
    environmentsWithheld: z.array(z.string().min(1)),
  })
  .strict();

export type AgentOperationalState = z.infer<typeof agentOperationalStateSchema>;

export type AttestationKind = "runtime" | "identity" | "tool_access";

/**
 * An observation, bound to the envelope it was made against.
 *
 * `(generation, digest)` and not a digest alone: `A → B → A` returns the
 * original digest, so an attestation taken during the first `A` would silently
 * validate the second. The generation is monotonic, so equal content at an
 * older generation is stale.
 */
export const agentAttestationSchema = z
  .object({
    agentName: z.string().min(1),
    environment: z.string().min(1),
    kind: z.enum(["runtime", "identity", "tool_access"]),
    /*
     * A DECIMAL STRING, not a number. PostgreSQL `bigint` exceeds
     * `Number.MAX_SAFE_INTEGER`, and `Number.parseInt` would silently collapse
     * distinct generations into one — which reads as "same generation", the
     * one answer that must never be wrong here. Compared by exact equality;
     * use `BigInt()` if ordering is ever needed.
     */
    envelopeGeneration: z.string().regex(/^\d+$/u),
    envelopeDigest: z.string().min(1),
    ready: z.boolean(),
    detail: z.string(),
    observedAt: z.string(),
  })
  .strict();

export type AgentAttestation = z.infer<typeof agentAttestationSchema>;

/**
 * The management plane's view. Deliberately NARROW: suspend and resume, and
 * reads. There is no create, no enable, no field for anything the envelope
 * owns. Widening this interface is a design change, not an implementation
 * detail — see the document before adding a method.
 */
export interface AgentRepository {
  readonly mode: "mock" | "real" | "disabled";
  /** every activated Agent in this environment; absent from the list means never activated */
  list(environment: string): Promise<AgentOperationalState[]>;
  get(agentName: string, environment: string): Promise<AgentOperationalState | undefined>;
  /** narrows immediately; must never wait for a review cycle */
  suspend(input: { agentName: string; environment: string; by: string; reason: string }): Promise<void>;
  /**
   * Clears the operational suspension and NOTHING ELSE.
   *
   * Resuming does not make an Agent Active or routable. It removes one term
   * from the meet; the Agent is then re-evaluated against the current envelope,
   * activation eligibility and fresh attestations, and returns to the catalog
   * only if all of those are positively valid. If Git narrowed or revoked the
   * envelope while it was suspended, resume restores only what is still
   * approved — possibly nothing.
   */
  resume(input: { agentName: string; environment: string }): Promise<void>;
  attestations(environment: string): Promise<AgentAttestation[]>;
  /**
   * Rows and attestations from ONE consistent read.
   *
   * Two separate queries can straddle a commit: the row set is read before a
   * suspension lands and the attestations after it, producing a snapshot the
   * database never held — an Agent that reads unsuspended and fully attested
   * at the same instant it was being suspended. The resolver would then keep
   * routing to it until the next refresh.
   */
  snapshot(environment: string): Promise<{ rows: AgentOperationalState[]; attestations: AgentAttestation[] }>;
  close(): Promise<void>;
}

/**
 * No operational control plane wired. Every Agent reads as never-activated,
 * which is the fail-closed answer — a deployment that has not adopted this
 * cannot accidentally inherit an empty table as "everything is suspended" OR as
 * "everything is running". The resolver's caller decides how to treat that;
 * see `operationalMeet` for the deliberate compatibility path.
 */
export class DisabledAgentRepository implements AgentRepository {
  readonly mode = "disabled" as const;
  async list(): Promise<AgentOperationalState[]> { return []; }
  async get(): Promise<undefined> { return undefined; }
  async suspend(): Promise<void> { throw new Error("no operational control plane is configured"); }
  async resume(): Promise<void> { throw new Error("no operational control plane is configured"); }
  async attestations(): Promise<AgentAttestation[]> { return []; }
  async snapshot(): Promise<{ rows: AgentOperationalState[]; attestations: AgentAttestation[] }> { return { rows: [], attestations: [] }; }
  async close(): Promise<void> {}
}

/** In-memory, for tests and local runs. Enforces the same rules as the schema. */
export class MockAgentRepository implements AgentRepository {
  readonly mode = "mock" as const;
  readonly #rows = new Map<string, AgentOperationalState>();
  readonly #attestations = new Map<string, AgentAttestation>();

  /** the reconciler's INSERT; deliberately NOT part of AgentRepository */
  activate(state: Omit<AgentOperationalState, "activatedAt"> & { activatedAt?: string }): void {
    const key = `${state.agentName}:${state.environment}`;
    const existing = this.#rows.get(key);
    // activated_at is written once; a re-activation must not move the epoch
    this.#rows.set(key, agentOperationalStateSchema.parse({
      ...state,
      activatedAt: existing?.activatedAt ?? state.activatedAt ?? new Date().toISOString(),
    }));
  }

  /** the reconciler's DELETE, for an Agent Git no longer approves */
  deactivate(agentName: string, environment: string): void {
    this.#rows.delete(`${agentName}:${environment}`);
  }

  forgetAttestation(agentName: string, environment: string, kind: AttestationKind): void {
    this.#attestations.delete(`${agentName}:${environment}:${kind}`);
  }

  attest(attestation: AgentAttestation): void {
    const value = agentAttestationSchema.parse(attestation);
    this.#attestations.set(`${value.agentName}:${value.environment}:${value.kind}`, value);
  }

  async list(environment: string): Promise<AgentOperationalState[]> {
    return [...this.#rows.values()].filter((row) => row.environment === environment).map((row) => structuredClone(row));
  }

  async get(agentName: string, environment: string): Promise<AgentOperationalState | undefined> {
    const row = this.#rows.get(`${agentName}:${environment}`);
    return row === undefined ? undefined : structuredClone(row);
  }

  async suspend(input: { agentName: string; environment: string; by: string; reason: string }): Promise<void> {
    const row = this.#mutable(input.agentName, input.environment);
    this.#rows.set(`${input.agentName}:${input.environment}`, {
      ...row,
      suspended: true,
      suspendedBy: input.by,
      suspendedReason: input.reason,
      suspendedAt: new Date().toISOString(),
    });
  }

  async resume(input: { agentName: string; environment: string }): Promise<void> {
    const row = this.#mutable(input.agentName, input.environment);
    // clears the suspension and NOTHING else: every other narrowing term
    // survives, and routability is re-derived rather than granted here
    const { suspendedBy: _by, suspendedReason: _reason, suspendedAt: _at, ...rest } = row;
    this.#rows.set(`${input.agentName}:${input.environment}`, { ...rest, suspended: false });
  }

  async attestations(environment: string): Promise<AgentAttestation[]> {
    return [...this.#attestations.values()].filter((item) => item.environment === environment).map((item) => structuredClone(item));
  }

  // synchronous in-memory maps cannot interleave; the pair is atomic already
  async snapshot(environment: string): Promise<{ rows: AgentOperationalState[]; attestations: AgentAttestation[] }> {
    return { rows: await this.list(environment), attestations: await this.attestations(environment) };
  }

  async close(): Promise<void> {}

  /**
   * The management plane may only UPDATE an existing row. Refusing here mirrors
   * the absent INSERT grant: suspending an Agent that was never activated must
   * not create its activation.
   */
  #mutable(agentName: string, environment: string): AgentOperationalState {
    const row = this.#rows.get(`${agentName}:${environment}`);
    if (row === undefined) throw new Error(`agent "${agentName}" is not activated in ${environment}`);
    return row;
  }
}

const ROW_COLUMNS = "agent_name, environment, activated_at, suspended, suspended_reason, suspended_by, suspended_at, replica_ceiling, environments_withheld";

interface OperationalRow {
  agent_name: string;
  environment: string;
  activated_at: Date;
  suspended: boolean;
  suspended_reason: string | null;
  suspended_by: string | null;
  suspended_at: Date | null;
  replica_ceiling: number;
  environments_withheld: string[];
}

/**
 * PostgreSQL. Holds NO INSERT and NO DELETE by design — those are the
 * reconciler's, granted to a different role in
 * `deploy/runtime/postgres/002_agent_operational_state.sql`. If a query here
 * ever needs one, that is the signal that the boundary is being crossed.
 */
export class PostgresAgentRepository implements AgentRepository {
  readonly mode = "real" as const;
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 10 });
  }

  async list(environment: string): Promise<AgentOperationalState[]> {
    const result = await this.#pool.query<OperationalRow>(
      `SELECT ${ROW_COLUMNS} FROM sre_agent_operational_state WHERE environment = $1`,
      [environment],
    );
    return result.rows.map(toState);
  }

  async get(agentName: string, environment: string): Promise<AgentOperationalState | undefined> {
    const result = await this.#pool.query<OperationalRow>(
      `SELECT ${ROW_COLUMNS} FROM sre_agent_operational_state WHERE agent_name = $1 AND environment = $2`,
      [agentName, environment],
    );
    return result.rows[0] === undefined ? undefined : toState(result.rows[0]);
  }

  async suspend(input: { agentName: string; environment: string; by: string; reason: string }): Promise<void> {
    // UPDATE, never UPSERT: an Agent that was never activated must not be
    // activated by being suspended, and the role holds no INSERT to do it with
    const result = await this.#pool.query(
      `UPDATE sre_agent_operational_state
          SET suspended = true, suspended_by = $3, suspended_reason = $4, suspended_at = NOW()
        WHERE agent_name = $1 AND environment = $2`,
      [input.agentName, input.environment, input.by, input.reason],
    );
    if (result.rowCount === 0) throw new Error(`agent "${input.agentName}" is not activated in ${input.environment}`);
  }

  async resume(input: { agentName: string; environment: string }): Promise<void> {
    /*
     * Clears the suspension and NOTHING ELSE. It does not set Active, it does
     * not touch the ceiling, it does not un-withhold an environment. The Agent
     * is re-evaluated against the current envelope, its activation row and
     * fresh attestations, and returns to the catalog only if all of those are
     * positively valid.
     *
     * The suspension metadata is cleared here, matching the in-memory
     * implementation exactly — two stores that disagree about what resume means
     * would make every test of one a lie about the other. History lives in the
     * audit trigger's record, which has already captured both transitions.
     *
     * There is no `by`: no column records who resumed, and a parameter that is
     * accepted and dropped would imply an accountability this table does not
     * provide. The actor is carried by the request event instead.
     */
    const result = await this.#pool.query(
      `UPDATE sre_agent_operational_state
          SET suspended = false, suspended_at = NULL, suspended_by = NULL, suspended_reason = NULL
        WHERE agent_name = $1 AND environment = $2`,
      [input.agentName, input.environment],
    );
    if (result.rowCount === 0) throw new Error(`agent "${input.agentName}" is not activated in ${input.environment}`);
  }

  async attestations(environment: string): Promise<AgentAttestation[]> {
    const result = await this.#pool.query<AttestationRow>(
      "SELECT agent_name, environment, kind, envelope_generation, envelope_digest, ready, detail, observed_at FROM sre_agent_attestation WHERE environment = $1",
      [environment],
    );
    return result.rows.map(toAttestation);
  }

  /**
   * One REPEATABLE READ transaction, so both halves describe the same instant.
   */
  async snapshot(environment: string): Promise<{ rows: AgentOperationalState[]; attestations: AgentAttestation[] }> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const rows = await client.query<OperationalRow>(
        `SELECT ${ROW_COLUMNS} FROM sre_agent_operational_state WHERE environment = $1`,
        [environment],
      );
      const attestations = await client.query<AttestationRow>(
        "SELECT agent_name, environment, kind, envelope_generation, envelope_digest, ready, detail, observed_at FROM sre_agent_attestation WHERE environment = $1",
        [environment],
      );
      await client.query("COMMIT");
      return { rows: rows.rows.map(toState), attestations: attestations.rows.map(toAttestation) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

interface AttestationRow {
  agent_name: string;
  environment: string;
  kind: AttestationKind;
  envelope_generation: string;
  envelope_digest: string;
  ready: boolean;
  detail: string;
  observed_at: Date;
}

function toAttestation(row: AttestationRow): AgentAttestation {
  return agentAttestationSchema.parse({
    agentName: row.agent_name,
    environment: row.environment,
    kind: row.kind,
    // `pg` hands bigint back as a string; keeping it that way is what makes it lossless
    envelopeGeneration: row.envelope_generation,
    envelopeDigest: row.envelope_digest,
    ready: row.ready,
    detail: row.detail,
    observedAt: row.observed_at.toISOString(),
  });
}

function toState(row: OperationalRow): AgentOperationalState {
  return agentOperationalStateSchema.parse({
    agentName: row.agent_name,
    environment: row.environment,
    activatedAt: row.activated_at.toISOString(),
    suspended: row.suspended,
    ...(row.suspended_reason === null ? {} : { suspendedReason: row.suspended_reason }),
    ...(row.suspended_by === null ? {} : { suspendedBy: row.suspended_by }),
    ...(row.suspended_at === null ? {} : { suspendedAt: row.suspended_at.toISOString() }),
    replicaCeiling: row.replica_ceiling,
    environmentsWithheld: row.environments_withheld,
  });
}

/**
 * THE ACTIVATION IDENTITY.
 *
 * Creates the row that IS the reviewed activation, and removes one for an Agent
 * Git no longer approves. It holds no UPDATE at all: it may bring an Agent into
 * existence here or take it out, never operate it.
 *
 * Separate from `AttestationStore` on purpose. One credential that could both
 * activate an Agent and vouch for its readiness would make the architecture's
 * two-identity promise false, so they are different interfaces backed by
 * different database roles and different connections.
 */
export interface ActivationStore {
  listActivated(environment: string): Promise<string[]>;
  /** idempotent: re-activating must not move the activation epoch */
  activate(input: { agentName: string; environment: string; replicaCeiling: number }): Promise<void>;
  deactivate(agentName: string, environment: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * THE ATTESTATION IDENTITY.
 *
 * Draws a generation from the shared sequence and records what it actually
 * verified. It cannot create an activation row, so it cannot bring an Agent
 * into existence by vouching for one.
 */
export interface AttestationStore {
  /**
   * The next value of the SHARED sequence.
   *
   * A decimal string, never a number: PostgreSQL `bigint` exceeds
   * `Number.MAX_SAFE_INTEGER`, and a collapsed generation reads as "same
   * generation", which is the one wrong answer here. Shared rather than
   * per-process because replicas must agree on ordering.
   */
  nextGeneration(): Promise<string>;
  /**
   * Records an attestation, and reports whether it was actually applied.
   *
   * `false` means a NEWER generation is already stored, so the write was
   * discarded. Returning void here hid a database restored to a lower sequence
   * value: every honest write silently skipped, and the estate ageing out of
   * the catalog with no error anywhere to explain it.
   */
  record(attestation: AgentAttestation): Promise<boolean>;
  /**
   * Drop every attestation for an Agent whose stamp is not the current
   * envelope.
   *
   * Overwriting per round is not enough on its own: a round that loads a NEW
   * envelope and then fails before writing leaves the PREVIOUS envelope's
   * complete, still-fresh set in place. If Git then returns to that previous
   * envelope, the untouched set matches again and routes with no
   * re-verification. Invalidating first means a change always costs the old
   * proof, whether or not the round that noticed it succeeds.
   */
  invalidateStale(environment: string, current: ReadonlyMap<string, string>): Promise<number>;
  close(): Promise<void>;
}

export class PostgresActivationStore implements ActivationStore {
  readonly #pool: Pool;
  /** its OWN connection string, so the role split is real and not conventional */
  constructor(connectionString: string) { this.#pool = new Pool({ connectionString, max: 4 }); }

  async listActivated(environment: string): Promise<string[]> {
    const result = await this.#pool.query<{ agent_name: string }>(
      "SELECT agent_name FROM sre_agent_operational_state WHERE environment = $1",
      [environment],
    );
    return result.rows.map((row) => row.agent_name);
  }

  async activate(input: { agentName: string; environment: string; replicaCeiling: number }): Promise<void> {
    /*
     * DO NOTHING, not DO UPDATE. Re-activating an Agent that is already
     * activated must be a no-op: moving `activated_at` would erase the epoch
     * that distinguishes a resume from a first activation, and this role holds
     * no UPDATE with which to do it anyway.
     */
    await this.#pool.query(
      `INSERT INTO sre_agent_operational_state(agent_name, environment, replica_ceiling)
       VALUES ($1, $2, $3)
       ON CONFLICT (agent_name, environment) DO NOTHING`,
      [input.agentName, input.environment, input.replicaCeiling],
    );
  }

  async deactivate(agentName: string, environment: string): Promise<void> {
    await this.#pool.query(
      "DELETE FROM sre_agent_operational_state WHERE agent_name = $1 AND environment = $2",
      [agentName, environment],
    );
  }

  async close(): Promise<void> { await this.#pool.end(); }
}

export class PostgresAttestationStore implements AttestationStore {
  readonly #pool: Pool;
  constructor(connectionString: string) { this.#pool = new Pool({ connectionString, max: 4 }); }

  async nextGeneration(): Promise<string> {
    // `::text` so the bigint never passes through a JavaScript number
    const result = await this.#pool.query<{ generation: string }>("SELECT nextval('sre_envelope_generation_seq')::text AS generation");
    const generation = result.rows[0]?.generation;
    if (generation === undefined) throw new Error("the envelope generation sequence returned nothing");
    return generation;
  }

  async record(attestation: AgentAttestation): Promise<boolean> {
    const value = agentAttestationSchema.parse(attestation);
    /*
     * NEVER GO BACKWARDS. Two reconcilers can race, and an older round's write
     * arriving after a newer one would silently re-bless a superseded envelope.
     * The guard is in the statement rather than in a read-then-write, so
     * concurrent writers cannot interleave around it.
     */
    const result = await this.#pool.query(
      `INSERT INTO sre_agent_attestation(agent_name, environment, kind, envelope_generation, envelope_digest, ready, detail, observed_at)
       VALUES ($1, $2, $3, $4::bigint, $5, $6, $7, $8)
       ON CONFLICT (agent_name, environment, kind) DO UPDATE
         SET envelope_generation = EXCLUDED.envelope_generation,
             envelope_digest     = EXCLUDED.envelope_digest,
             ready               = EXCLUDED.ready,
             detail              = EXCLUDED.detail,
             observed_at         = EXCLUDED.observed_at
       WHERE EXCLUDED.envelope_generation >= sre_agent_attestation.envelope_generation`,
      [value.agentName, value.environment, value.kind, value.envelopeGeneration, value.envelopeDigest, value.ready, value.detail, value.observedAt],
    );
    /*
     * When the guard is false PostgreSQL locks the conflicting row, performs no
     * update and returns success with zero rows affected. Silence is exactly
     * what must not be reported as a successful write.
     */
    return (result.rowCount ?? 0) > 0;
  }

  async invalidateStale(environment: string, current: ReadonlyMap<string, string>): Promise<number> {
    const names = [...current.keys()];
    const digests = [...current.values()];
    /*
     * Delete anything in this environment whose (agent, digest) pair is not one
     * of the current ones — including attestations for Agents that are no
     * longer approved at all, whose rows would otherwise outlive their
     * activation and be waiting if the Agent is ever re-approved unchanged.
     */
    const result = await this.#pool.query(
      `DELETE FROM sre_agent_attestation
        WHERE environment = $1
          AND NOT (agent_name = ANY($2::text[]) AND envelope_digest = ANY($3::text[])
                   AND (agent_name, envelope_digest) IN (SELECT * FROM unnest($2::text[], $3::text[])))`,
      [environment, names, digests],
    );
    return result.rowCount ?? 0;
  }

  async close(): Promise<void> { await this.#pool.end(); }
}

/** In-memory activation + attestation, for tests. Same rules, no database. */
export class MockReconcilerStores implements ActivationStore, AttestationStore {
  #generation = 0n;
  readonly repository: MockAgentRepository;
  constructor(repository: MockAgentRepository) { this.repository = repository; }

  async listActivated(environment: string): Promise<string[]> {
    return (await this.repository.list(environment)).map((row) => row.agentName);
  }

  async activate(input: { agentName: string; environment: string; replicaCeiling: number }): Promise<void> {
    this.repository.activate({ ...input, suspended: false, environmentsWithheld: [] });
  }

  async deactivate(agentName: string, environment: string): Promise<void> {
    this.repository.deactivate(agentName, environment);
  }

  async nextGeneration(): Promise<string> {
    this.#generation += 1n;
    return this.#generation.toString();
  }

  async record(attestation: AgentAttestation): Promise<boolean> {
    const existing = (await this.repository.attestations(attestation.environment))
      .find((item) => item.agentName === attestation.agentName && item.kind === attestation.kind);
    // the same non-decreasing guard the SQL applies, so tests exercise the rule
    if (existing !== undefined && BigInt(attestation.envelopeGeneration) < BigInt(existing.envelopeGeneration)) return false;
    this.repository.attest(attestation);
    return true;
  }

  async invalidateStale(environment: string, current: ReadonlyMap<string, string>): Promise<number> {
    let removed = 0;
    for (const item of await this.repository.attestations(environment)) {
      if (current.get(item.agentName) === item.envelopeDigest) continue;
      this.repository.forgetAttestation(item.agentName, environment, item.kind);
      removed += 1;
    }
    return removed;
  }

  async close(): Promise<void> {}
}
