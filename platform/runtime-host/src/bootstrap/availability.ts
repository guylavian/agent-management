import type { AgentCatalog, AgentCatalogEntry } from "@sre/config";
import { unobserved, type RuntimeProbe, type Signal } from "../management/reconciliation.ts";
import type { DesiredStateSource } from "./desired-state.ts";

/**
 * ACTUAL AVAILABILITY, as a gate on the Manager's catalog.
 *
 * Desired state says an Agent SHOULD be running. That is not the same as it
 * being reachable, and the Manager used to be offered the first while needing
 * the second: a merged, enabled Agent whose pod was crash-looping was routed to
 * on merit, failed at fan-out, and came back to the user as a degraded answer
 * with an evidence gap — when the correct behaviour was never to offer it.
 *
 * So the effective catalog is now:
 *
 *     lifecycle active  ∩  enabled in this environment  ∩  not observed failing
 *
 * FAIL-OPEN ON UNKNOWN, deliberately. A deployment with no probe configured
 * observes nothing, and treating "nobody looked" as "not available" would empty
 * the catalog and take routing down everywhere the probe is not wired. Only a
 * POSITIVE observation of failure removes an Agent, which is the same rule the
 * console renders: nothing is invented in either direction.
 */
export interface AvailabilityView {
  /** the last observation for an Agent; `unknown` when nothing has looked */
  signal(agentId: string): Signal;
}

export const NOTHING_OBSERVED: AvailabilityView = {
  signal: () => unobserved("no runtime health probe is configured for this deployment"),
};

/**
 * Probes every enabled Agent on an interval and keeps the last answer.
 *
 * A background sweep rather than a probe inside `listEnabled`, because routing
 * is a synchronous decision on the request path: making it await an HTTP call
 * per candidate would put the health of the slowest pod on the latency of every
 * question. The sweep is the only place that waits.
 */
export class ProbeAvailabilityMonitor implements AvailabilityView {
  readonly #probe: RuntimeProbe;
  readonly #endpoints: () => AgentCatalogEntry[];
  readonly #observations = new Map<string, Signal>();
  #timer?: ReturnType<typeof setInterval>;
  #inFlight?: Promise<void>;

  constructor(probe: RuntimeProbe, endpoints: () => AgentCatalogEntry[]) {
    this.#probe = probe;
    this.#endpoints = endpoints;
  }

  signal(agentId: string): Signal {
    return this.#observations.get(agentId) ?? unobserved("this Agent has not been probed yet");
  }

  /** Begin sweeping. `unref` so a probe timer never keeps a process alive. */
  start(intervalMs = 10_000): this {
    if (this.#timer !== undefined) return this;
    // a rejected sweep must not surface as an unhandled rejection and take the
    // process down over a health check
    const safely = () => { void this.sweep().catch(() => {}); };
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
   * One pass. `allSettled`, never `all`: one unreachable pod must not abort the
   * sweep and leave every other Agent's observation frozen at its last value.
   */
  async sweep(): Promise<void> {
    /*
     * One at a time. A sweep slower than the interval would otherwise overlap
     * itself, and the older pass's stale-entry pruning would delete the
     * observations the newer one had just written — an Agent flickering out of
     * the routing catalog for no reason anyone could reproduce.
     */
    this.#inFlight ??= this.#sweepOnce().finally(() => { this.#inFlight = undefined; });
    return this.#inFlight;
  }

  async #sweepOnce(): Promise<void> {
    const entries = this.#endpoints();
    const results = await Promise.allSettled(entries.map((entry) => this.#probe.status(entry.agentId, entry.endpoint)));
    const seen = new Set<string>();
    for (const [index, result] of results.entries()) {
      const entry = entries[index];
      if (entry === undefined) continue;
      seen.add(entry.agentId);
      this.#observations.set(
        entry.agentId,
        // a probe that THREW observed nothing; recording it as a failure would
        // remove a healthy Agent from routing because of a bug in the prober
        result.status === "fulfilled" ? result.value : unobserved("the runtime probe failed"),
      );
    }
    // an Agent that left desired state must not leave a stale observation
    // behind for the day someone adds it back — a forgotten "degraded" would
    // silently keep it out of routing with nothing to explain why
    const stale: string[] = [];
    for (const agentId of this.#observations.keys()) {
      if (!seen.has(agentId)) stale.push(agentId);
    }
    for (const agentId of stale) this.#observations.delete(agentId);
  }
}

/**
 * THE ONE ROUTING CATALOG.
 *
 * Desired state re-read on demand, intersected with observed availability. The
 * management API asks this same object whether an Agent is routable, so the
 * console cannot show a green "Routable" for something the router will refuse
 * — they are not two derivations of one rule, they are one call.
 */
export function effectiveCatalog(source: DesiredStateSource, availability: AvailabilityView = NOTHING_OBSERVED): AgentCatalog {
  const available = (agentId: string): boolean => availability.signal(agentId).state !== "degraded";
  return {
    // `resolve` is NOT gated: a discovered domain that exists but is unavailable
    // must stay distinguishable from one that was never an Agent at all, and
    // Round 2 reports those as different rejections
    resolve: (agentId) => source.current().catalog.resolve(agentId),
    listEnabled: (environment) => source.current().catalog.listEnabled(environment).filter((entry) => available(entry.agentId)),
    // the authoritative gate before dispatch, so availability is enforced on
    // the follow-up path too and not only on what the Manager was offered
    filterAuthorized: (agentIds, roles, environment) =>
      source.current().catalog.filterAuthorized(agentIds, roles, environment).filter(available),
    mayRequestDomain: (origin, target) => source.current().catalog.mayRequestDomain(origin, target),
  };
}
