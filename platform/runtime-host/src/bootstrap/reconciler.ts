import type { SpecialistAgentConfig } from "@sre/config";
import type { AgentAttestation, ActivationStore, AttestationStore, AttestationKind } from "@sre/orchestrator";
import type { RuntimeProbe } from "../management/reconciliation.ts";
import type { DesiredStateSource } from "./desired-state.ts";
import { envelopeDigest } from "./operational.ts";

/**
 * THE RECONCILER.
 *
 * It answers two questions, with two different identities:
 *
 *   ACTIVATION   — does Git currently approve this Agent to run here?
 *                  Creates or removes the row that IS the reviewed activation.
 *   ATTESTATION  — did I just verify, myself, that each subsystem is ready?
 *                  Records what it observed, stamped with the exact envelope.
 *
 * The rules it must never break:
 *
 *  - **Never activate from an envelope it cannot vouch for.** A desired-state
 *    snapshot carrying a reload error may predate a narrowing or a revocation,
 *    so a round that finds one does nothing at all rather than acting on it.
 *  - **Never emit READY for a subsystem it did not verify.** An unconfigured
 *    verifier reports NOT ready with the reason it could not look. The resolver
 *    requires all three, so unconfigured means not routable — fail closed, and
 *    visibly so.
 *  - **One generation per round**, drawn from the shared PostgreSQL sequence,
 *    so replicas order attestations the same way and no per-process counter is
 *    ever the authority.
 *  - **Idempotent.** Every round is a full convergence, so a retry is simply
 *    the next round. There is no partial state to resume from.
 */

/** The subsystems that must each attest, independently, before an Agent routes. */
export const REQUIRED_KINDS: readonly AttestationKind[] = ["runtime", "identity", "tool_access"];

export interface SubsystemResult {
  ready: boolean;
  /** always present: a verdict with no reason is not diagnosable */
  detail: string;
}

/** Verifies that the Agent's workload identity is reconciled in the IdP. */
export interface IdentityVerifier {
  verify(agent: SpecialistAgentConfig, environment: string): Promise<SubsystemResult>;
}

/** Verifies that the tool gateway is enforcing this Agent's approved grants. */
export interface ToolAccessVerifier {
  verify(agent: SpecialistAgentConfig, environment: string): Promise<SubsystemResult>;
}

/**
 * What an unwired subsystem reports.
 *
 * NOT `ready`, and never silently absent. A deployment that has not connected a
 * verifier must see its Agents stay out of the catalog with a reason naming the
 * missing verifier — not quietly route on an assumption nobody made.
 */
export function notVerified(subsystem: string): SubsystemResult {
  return { ready: false, detail: `no ${subsystem} verifier is configured, so readiness was never established` };
}

export interface ReconcileReport {
  /** set when the round did nothing, and why */
  skipped?: string;
  generation?: string;
  activated: string[];
  deactivated: string[];
  /** attestations dropped because their envelope is no longer the current one */
  invalidated?: number;
  attested: Array<{ agentName: string; kind: AttestationKind; ready: boolean }>;
  failures: Array<{ agentName: string; error: string }>;
}

/**
 * ONE STORE PER SUBSYSTEM, each on its own database role.
 *
 * Row-level security confines `sre_attest_runtime` to `kind = 'runtime'`, and
 * so on. Handing the reconciler a single store would put all three credentials
 * behind one connection and make the independence nominal — the point is that a
 * stolen attester credential can forge one third of the proof, not all of it.
 *
 * The reconciler process still holds all three, so process compromise is not
 * bounded by this; that is stated in the architecture document, where the
 * reconciler is named as part of the trusted computing base.
 */
export type AttestationStores = Record<AttestationKind, AttestationStore>;

/** Every kind through one store. For tests, and for a single-credential deployment. */
export function singleAttester(store: AttestationStore): AttestationStores {
  return { runtime: store, identity: store, tool_access: store };
}

export interface ReconcilerOptions {
  desiredState: DesiredStateSource;
  environment: string;
  activation: ActivationStore;
  attestation: AttestationStores;
  runtimeProbe?: RuntimeProbe;
  identity?: IdentityVerifier;
  toolAccess?: ToolAccessVerifier;
  now?: () => number;
}

export class AgentReconciler {
  readonly #options: ReconcilerOptions;
  readonly #now: () => number;
  #timer?: ReturnType<typeof setInterval>;
  #inFlight?: Promise<ReconcileReport>;

  constructor(options: ReconcilerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  start(intervalMs = 15_000): this {
    if (this.#timer !== undefined) return this;
    const safely = () => { void this.reconcile().catch(() => {}); };
    safely();
    this.#timer = setInterval(safely, intervalMs);
    this.#timer.unref?.();
    return this;
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * One full convergence.
   *
   * Serialised: two overlapping rounds would draw two generations and could
   * write them out of order, so a round in flight is returned rather than a
   * second one started. Retries are bounded by construction — the next tick IS
   * the retry, and each round is independent.
   */
  async reconcile(): Promise<ReconcileReport> {
    this.#inFlight ??= this.#reconcileOnce().finally(() => { this.#inFlight = undefined; });
    return this.#inFlight;
  }

  async #reconcileOnce(): Promise<ReconcileReport> {
    const report: ReconcileReport = { activated: [], deactivated: [], attested: [], failures: [] };

    /*
     * THE GENERATION IS DRAWN FIRST, BEFORE desired state is captured.
     *
     * The other order loses races. A round that captured envelope A, paused,
     * and resumed after a second round had captured and written B would draw a
     * HIGHER generation than B and overwrite it — the stale envelope winning
     * because it happened to be scheduled last. Drawing first makes the
     * generation order the capture order, so the `>=` guard in the store
     * discards the stale write instead of the fresh one.
     */
    // any attester may draw it; all three hold USAGE on the shared sequence
    const generation = await this.#options.attestation.runtime.nextGeneration();
    const snapshot = this.#options.desiredState.current();

    if (snapshot.error !== undefined) {
      /*
       * NEVER ACT ON AN ENVELOPE WE CANNOT VOUCH FOR.
       *
       * A snapshot carrying a reload error may predate a narrowing or a
       * revocation. Activating from it would be activation after revocation;
       * attesting from it would bless an envelope that no longer exists. Doing
       * nothing leaves the previous state, which the resolver ages out on its
       * own.
       */
      return { ...report, skipped: `desired state did not load: ${snapshot.error}` };
    }
    if (snapshot.environment !== this.#options.environment) {
      // a runtime serving one environment must never write another's rows
      return { ...report, skipped: `desired state is for ${snapshot.environment}, not ${this.#options.environment}` };
    }

    // Git's current answer to "may this Agent run here", and nothing else
    const approved = snapshot.registry.listSpecialists().filter((agent) =>
      agent.spec.lifecycle === "active" && snapshot.overlays.get(agent.name)?.enabled === true);
    const approvedNames = new Set(approved.map((agent) => agent.name));

    report.generation = generation;

    const activated = new Set(await this.#options.activation.listActivated(this.#options.environment));

    // converge activations, in both directions
    for (const agent of approved) {
      if (activated.has(agent.name)) continue;
      const overlay = snapshot.overlays.get(agent.name);
      await this.#options.activation.activate({
        agentName: agent.name,
        environment: this.#options.environment,
        replicaCeiling: overlay?.replicas ?? 1,
      });
      report.activated.push(agent.name);
    }
    for (const name of activated) {
      if (approvedNames.has(name)) continue;
      // revocation converges: Git no longer approves it, so the activation goes
      await this.#options.activation.deactivate(name, this.#options.environment);
      report.deactivated.push(name);
    }

    /*
     * INVALIDATE FIRST. Compute every approved Agent's current digest, then
     * drop any attestation that does not match one — before verifying anything.
     *
     * Overwriting per round is not enough: a round that loads a NEW envelope
     * and fails before writing leaves the PREVIOUS envelope's complete, still
     * fresh set in place, ready to route again the moment Git returns to it.
     * Invalidating first means an envelope change always costs the old proof,
     * whether or not the round that noticed it goes on to succeed.
     */
    const currentDigests = new Map(approved.map((agent) =>
      [agent.name, envelopeDigest(agent, snapshot.environment, snapshot.overlays.get(agent.name))]));
    /*
     * Each attester invalidates its OWN kind: row-level security means a
     * runtime credential cannot delete an identity attestation, so the sweep
     * has to be made by all three.
     */
    const invalidations = await Promise.all(REQUIRED_KINDS.map((kind) =>
      this.#options.attestation[kind].invalidateStale(this.#options.environment, currentDigests)));
    report.invalidated = invalidations.reduce((total, count) => total + count, 0);

    /*
     * Attest each Agent independently. `allSettled`: one unreachable subsystem
     * must not abort the round and leave every other Agent un-attested, which
     * would age the whole estate out of the catalog over a single failure.
     */
    const results = await Promise.allSettled(approved.map((agent) => this.#attest({
      agent,
      environment: snapshot.environment,
      generation,
      digest: currentDigests.get(agent.name) as string,
      // from the SAME snapshot the digest is computed from; a second
      // `current()` could straddle a reload and probe one envelope while
      // stamping the attestation with another
      endpoint: snapshot.catalog.resolve(agent.name)?.endpoint,
    })));
    for (const [index, result] of results.entries()) {
      const agent = approved[index] as SpecialistAgentConfig;
      if (result.status === "fulfilled") report.attested.push(...result.value);
      else report.failures.push({ agentName: agent.name, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
    }
    return report;
  }

  async #attest(input: {
    agent: SpecialistAgentConfig;
    environment: string;
    generation: string;
    /*
     * Computed ONCE per Agent per round, from the same snapshot every
     * verification runs against and the same one the invalidation used.
     * Recomputing it here could straddle a reload and stamp three attestations
     * with two different envelopes — each individually valid, together
     * describing nothing.
     */
    digest: string;
    endpoint?: string;
  }): Promise<Array<{ agentName: string; kind: AttestationKind; ready: boolean }>> {
    const { agent, environment, generation, digest } = input;

    /*
     * Each subsystem is stamped with the moment IT finished, not the moment the
     * slowest one did. Sharing one timestamp let a fast READY be laundered into
     * freshness by a slow sibling: runtime answers at T, identity blocks for an
     * hour, and runtime is then recorded as observed an hour later than it was.
     */
    const [runtime, identity, toolAccess] = await Promise.all([
      this.#timed(() => this.#verifyRuntime(agent, input.endpoint)),
      this.#timed(() => this.#options.identity?.verify(agent, environment) ?? Promise.resolve(notVerified("identity"))),
      this.#timed(() => this.#options.toolAccess?.verify(agent, environment) ?? Promise.resolve(notVerified("tool access"))),
    ]);

    const written: Array<{ agentName: string; kind: AttestationKind; ready: boolean }> = [];
    for (const [kind, observation] of [["runtime", runtime], ["identity", identity], ["tool_access", toolAccess]] as Array<[AttestationKind, { result: SubsystemResult; observedAt: string }]>) {
      const attestation: AgentAttestation = {
        agentName: agent.name,
        environment,
        kind,
        envelopeGeneration: generation,
        envelopeDigest: digest,
        ready: observation.result.ready,
        detail: observation.result.detail,
        observedAt: observation.observedAt,
      };
      const applied = await this.#options.attestation[kind].record(attestation);
      if (applied === false) {
        /*
         * The store refused the write because a newer generation is already
         * there. Reporting success would hide a database restored to a lower
         * sequence value, where every honest write is silently discarded and
         * the estate ages out with no error anywhere.
         */
        throw new Error(`the ${kind} attestation for ${agent.name} was superseded by a newer generation`);
      }
      written.push({ agentName: agent.name, kind, ready: observation.result.ready });
    }
    return written;
  }

  /** Stamp an observation with the moment it actually completed. */
  async #timed(verify: () => Promise<SubsystemResult>): Promise<{ result: SubsystemResult; observedAt: string }> {
    const result = await verify();
    return { result, observedAt: new Date(this.#now()).toISOString() };
  }

  async #verifyRuntime(agent: SpecialistAgentConfig, endpoint?: string): Promise<SubsystemResult> {
    const probe = this.#options.runtimeProbe;
    if (probe === undefined) return notVerified("runtime");
    if (endpoint === undefined) return { ready: false, detail: "the effective catalog resolved no endpoint for this Agent" };
    const signal = await probe.status(agent.name, endpoint);
    // `unknown` is NOT ready: the probe looked and could not tell, which is a
    // different thing from having verified readiness
    return { ready: signal.state === "ok", detail: signal.detail };
  }
}
