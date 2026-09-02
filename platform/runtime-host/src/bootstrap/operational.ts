import { createHash } from "node:crypto";
import type { AgentDeploymentOverlay, SpecialistAgentConfig } from "@sre/config";
import type { AgentAttestation, AgentOperationalState, AgentRepository, AttestationKind } from "@sre/orchestrator";

/**
 * THE OPERATIONAL MEET.
 *
 * Git approves an envelope. The database narrows it. The world attests to it.
 * An Agent is routable only where all three agree, and this is where that
 * conjunction is computed.
 *
 * The property that matters most here: **resume does not mean Active.**
 * Clearing a suspension removes ONE term from the meet. Everything else is
 * re-derived — the live envelope, the activation row, and fresh attestations
 * stamped with the envelope they were made against. If Git narrowed or revoked
 * while an Agent was suspended, resume restores only what is still approved,
 * which may be nothing at all.
 *
 * Every failure resolves to NOT ROUTABLE. Routability requires positive
 * evidence for every term; the absence of evidence is never evidence.
 *
 * See docs/architecture/hybrid-control-plane.md.
 */

/** The three things that must independently attest before an Agent may route. */
export const REQUIRED_ATTESTATIONS: readonly AttestationKind[] = ["runtime", "identity", "tool_access"];

export interface OperationalDecision {
  routable: boolean;
  /** always present: "not routable" with no reason is not diagnosable */
  reason: string;
}

/**
 * The digest of an Agent's RESOLVED envelope for one environment.
 *
 * It must cover everything a change to which should invalidate an attestation —
 * so the prompt BODY rather than its path, every access grant, the routing text
 * the Manager is shown, the identity, the model destination, the limits, and
 * the environment the observation was made in. A digest that omits any of them
 * would let an attestation survive a change to it, which is the resurrection
 * path this exists to close.
 */
export function envelopeDigest(agent: SpecialistAgentConfig, environment: string, overlay?: AgentDeploymentOverlay): string {
  // canonical, order-independent JSON: a key reordering must not read as a
  // change, and a real change must never fail to
  const canonical = JSON.stringify(
    {
      environment,
      name: agent.name,
      owner: agent.owner,
      displayName: agent.displayName ?? null,
      description: agent.description ?? null,
      // the prompt BODY, not the path it came from
      prompt: agent.systemPrompt,
      spec: agent.spec,
      // the WHOLE overlay, not a chosen subset: resources, serviceAccount and
      // endpoint all change what was deployed, and an attestation that survived
      // a change to any of them would be describing a workload that no longer
      // exists
      overlay: overlay ?? null,
    },
    sortedReplacer,
  );
  return createHash("sha256").update(canonical).digest("hex");
}

/** Stable key order, so an equivalent envelope always digests identically. */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
}

export interface OperationalSnapshot {
  rows: ReadonlyMap<string, AgentOperationalState>;
  attestations: ReadonlyMap<string, AgentAttestation>;
  /** when this snapshot was successfully read; undefined means never */
  refreshedAt?: number;
  error?: string;
}

const EMPTY: OperationalSnapshot = { rows: new Map(), attestations: new Map() };

export interface OperationalViewOptions {
  /** an attestation older than this is `unknown`, never `ready` */
  attestationTtlMs?: number;
  /** a snapshot older than this means the control plane is unavailable */
  snapshotTtlMs?: number;
  now?: () => number;
}

const DEFAULT_ATTESTATION_TTL_MS = 90_000;
/** how far ahead of us an attester's clock may legitimately be */
const CLOCK_SKEW_TOLERANCE_MS = 5_000;
const DEFAULT_SNAPSHOT_TTL_MS = 30_000;

/**
 * A synchronous view of the operational control plane, refreshed in the
 * background.
 *
 * Routing is a synchronous decision on the request path: awaiting a database
 * round trip per candidate would put the health of the slowest connection on
 * the latency of every question. The sweep is the only place that waits.
 */
export class OperationalStateView {
  readonly #repository: AgentRepository;
  readonly #environment: string;
  readonly #attestationTtlMs: number;
  readonly #snapshotTtlMs: number;
  readonly #now: () => number;
  /** the highest generation ever ACCEPTED per agent; a replay cannot go backwards */
  readonly #highWater = new Map<string, bigint>();
  #snapshot: OperationalSnapshot = EMPTY;
  #timer?: ReturnType<typeof setInterval>;
  #inFlight?: Promise<void>;

  constructor(repository: AgentRepository, environment: string, options: OperationalViewOptions = {}) {
    this.#repository = repository;
    this.#environment = environment;
    this.#attestationTtlMs = options.attestationTtlMs ?? DEFAULT_ATTESTATION_TTL_MS;
    this.#snapshotTtlMs = options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  /** `disabled` means no control plane is wired at all — see `operationalCatalog`. */
  get configured(): boolean {
    return this.#repository.mode !== "disabled";
  }

  start(intervalMs = 10_000): this {
    if (this.#timer !== undefined) return this;
    const safely = () => { void this.refresh().catch(() => {}); };
    safely();
    this.#timer = setInterval(safely, intervalMs);
    this.#timer.unref?.();
    return this;
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async refresh(): Promise<void> {
    // one at a time: overlapping reads could interleave a stale row set with a
    // newer attestation set and produce a snapshot neither half ever saw
    this.#inFlight ??= this.#refreshOnce().finally(() => { this.#inFlight = undefined; });
    return this.#inFlight;
  }

  async #refreshOnce(): Promise<void> {
    try {
      // ONE consistent read. Two separate queries can straddle a commit and
      // produce a snapshot the database never held — rows from before a
      // suspension, attestations from after it.
      const { rows, attestations } = await this.#repository.snapshot(this.#environment);
      this.#snapshot = {
        rows: new Map(rows.map((row) => [row.agentName, row])),
        attestations: new Map(attestations.map((item) => [`${item.agentName}:${item.kind}`, item])),
        refreshedAt: this.#now(),
      };
    } catch (error) {
      /*
       * Keep the rows for diagnosis, but mark the snapshot failed. The decision
       * function treats a failed or expired snapshot as unavailable, which is
       * NOT routable — falling back to Git alone would silently discard every
       * suspension, which is precisely the state an operator reached for.
       */
      this.#snapshot = { ...this.#snapshot, error: error instanceof Error ? error.message : String(error) };
    }
  }

  snapshot(): OperationalSnapshot {
    return this.#snapshot;
  }

  /**
   * May this Agent route, given the envelope it is being resolved against?
   *
   * Ordered so the reason names the FIRST thing that is missing, because every
   * later term is usually a consequence of it.
   */
  decide(agentId: string, envelopeDigestNow: string, requestedEnvironment: string): OperationalDecision {
    const now = this.#now();
    const snapshot = this.#snapshot;

    if (snapshot.refreshedAt === undefined) {
      return { routable: false, reason: "the operational control plane has not been read yet" };
    }
    if (snapshot.error !== undefined) {
      return { routable: false, reason: `the operational control plane is unavailable: ${snapshot.error}` };
    }
    if (now - snapshot.refreshedAt > this.#snapshotTtlMs) {
      return { routable: false, reason: "the operational control plane has not been read recently enough to trust" };
    }

    const row = snapshot.rows.get(agentId);
    if (row === undefined) {
      // row existence IS the reviewed activation; absence is never permissive
      return { routable: false, reason: "no activation record: this Agent has never been approved to run here" };
    }
    if (row.suspended) {
      return { routable: false, reason: `suspended${row.suspendedReason ? `: ${row.suspendedReason}` : ""}` };
    }
    /*
     * The REQUESTED logical environment, not this runtime's deployment
     * environment. They are different vocabularies — a runtime deployed as
     * `production` serves requests naming `prod`, `dr` or `lab` — and comparing
     * the withheld list against the wrong one meant withholding `prod` had no
     * effect at all while appearing to work.
     */
    if (row.environmentsWithheld.includes(requestedEnvironment)) {
      return { routable: false, reason: `withheld from ${requestedEnvironment}` };
    }
    if (row.replicaCeiling <= 0) {
      return { routable: false, reason: "the operational replica ceiling is zero" };
    }

    /*
     * ALL THREE FROM THE SAME ROUND.
     *
     * The reconciler writes runtime, identity and tool_access together under
     * ONE generation, so three attestations that disagree about it did not come
     * from one reconciliation. That covers two cases at once:
     *
     *  - PARTIAL RECONCILIATION — a reconciler that crashed after writing one
     *    subsystem leaves a mismatched set, which must not route.
     *  - REPLAY across `A -> B -> A` — a single kind replayed from an older
     *    round disagrees with the two that were written most recently.
     *
     * This replaced a wall-clock "has this process seen the envelope change"
     * heuristic, which cost a full reconcile round of availability after every
     * replica restart and still only approximated the property.
     */
    const generations = new Set<string>();
    for (const kind of REQUIRED_ATTESTATIONS) {
      const decision = this.#attestation(agentId, kind, envelopeDigestNow, now);
      if (!decision.routable) return decision;
      generations.add((this.#snapshot.attestations.get(`${agentId}:${kind}`) as AgentAttestation).envelopeGeneration);
    }
    if (generations.size > 1) {
      return { routable: false, reason: "the attestations come from different reconciliation rounds" };
    }
    return { routable: true, reason: `activated, not suspended, and attested against ${envelopeDigestNow.slice(0, 12)}` };
  }

  #attestation(agentId: string, kind: AttestationKind, envelopeDigestNow: string, now: number): OperationalDecision {
    const attestation = this.#snapshot.attestations.get(`${agentId}:${kind}`);
    if (attestation === undefined) {
      return { routable: false, reason: `no ${kind} attestation` };
    }
    if (attestation.envelopeDigest !== envelopeDigestNow) {
      /*
       * The attestation was made against a DIFFERENT envelope. This is the
       * resurrection path: narrow an Agent's access in Git while it is
       * suspended, resume it, and a stale `ready` would bless a pod, a Keycloak
       * client and a Cedar policy that all still reflect the old envelope.
       */
      return { routable: false, reason: `the ${kind} attestation was made against a different envelope` };
    }
    if (!attestation.ready) {
      return { routable: false, reason: `${kind} is not ready: ${attestation.detail}` };
    }
    const age = now - Date.parse(attestation.observedAt);
    if (age > this.#attestationTtlMs) {
      // a reconciler that stops running must degrade to not-routable, never to
      // permanently-blessed
      return { routable: false, reason: `the ${kind} attestation is stale` };
    }
    if (age < -CLOCK_SKEW_TOLERANCE_MS) {
      /*
       * A future-dated observation would never age out: `age > ttl` is false
       * forever. Writing one is how an attester with a clock — or an intent —
       * makes a blessing permanent.
       */
      return { routable: false, reason: `the ${kind} attestation is dated in the future` };
    }

    /*
     * MONOTONIC GENERATION. The digest cannot order anything on its own:
     * A -> B -> A returns the original digest, so an attestation captured
     * during the first A would validate the second. Refusing any generation
     * below the highest already accepted for this Agent makes a replay
     * unusable, whatever its digest says.
     */
    const key = `${agentId}:${kind}`;
    const generation = BigInt(attestation.envelopeGeneration);
    const seen = this.#highWater.get(key);
    if (seen !== undefined && generation < seen) {
      return { routable: false, reason: `the ${kind} attestation is a replay of an older envelope generation` };
    }
    this.#highWater.set(key, seen === undefined || generation > seen ? generation : seen);
    return { routable: true, reason: `${kind} attested` };
  }
}

/**
 * Narrow a catalog by the operational control plane.
 *
 * WHEN NO CONTROL PLANE IS CONFIGURED this is the identity function. That is a
 * deliberate compatibility path, not an oversight: a deployment that has not
 * adopted the operational plane must keep working exactly as before, and an
 * empty table would otherwise read as "everything is suspended" and empty the
 * estate on upgrade.
 *
 * The distinction that matters: **not configured** is a no-op; **configured but
 * unavailable** fails closed. Those must never collapse into each other.
 */
export function operationalCatalog(
  base: import("@sre/config").AgentCatalog,
  view: OperationalStateView,
  digestOf: (agentId: string) => string | undefined,
  /** used when a caller lists without naming one; the runtime's own default */
  defaultEnvironment: string,
): import("@sre/config").AgentCatalog {
  if (!view.configured) return base;

  const permitted = (agentId: string, environment: string): boolean => {
    const digest = digestOf(agentId);
    /*
     * `undefined` means the envelope cannot be resolved RIGHT NOW — the Agent
     * is gone from Git, or desired state failed to reload and the caller
     * refuses to admit anything from a snapshot it cannot vouch for. Either
     * way there is nothing to attest against, so nothing routes.
     */
    if (digest === undefined) return false;
    return view.decide(agentId, digest, environment).routable;
  };

  return {
    // NOT gated: a domain that exists but cannot route must stay
    // distinguishable from a name that was never an Agent, or Round 2 reports
    // the wrong rejection and sends someone to fix the wrong thing
    resolve: (agentId) => base.resolve(agentId),
    listEnabled: (environment) => {
      // an Agent's logical environments already bound this list; the withheld
      // check below needs the SAME name the caller asked for
      const requested = environment ?? defaultEnvironment;
      return base.listEnabled(environment).filter((entry) => permitted(entry.agentId, requested));
    },
    // the authoritative pre-dispatch gate, so a follow-up cannot reach an Agent
    // that was never offered
    filterAuthorized: (agentIds, roles, environment) => base.filterAuthorized(agentIds, roles, environment).filter((agentId) => permitted(agentId, environment)),
    mayRequestDomain: (origin, target) => base.mayRequestDomain(origin, target),
  };
}
