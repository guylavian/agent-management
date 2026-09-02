import { describe, expect, it } from "vitest";
import { StaticAgentCatalog, type AgentCatalogEntry } from "@sre/config";
import { DisabledAgentRepository, MockAgentRepository, type AgentAttestation } from "@sre/orchestrator";
import { OperationalStateView, envelopeDigest, operationalCatalog, REQUIRED_ATTESTATIONS } from "@sre/runtime-host";

/**
 * RESUME DOES NOT MEAN ACTIVE.
 *
 * Clearing a suspension removes ONE term from the meet. Routability is then
 * re-derived from the live envelope, the activation row and fresh attestations
 * stamped with the envelope they were made against. If Git narrowed or revoked
 * while the Agent was suspended, resume restores only what is still approved —
 * possibly nothing.
 *
 * Every test here is a way that could silently stop being true.
 */
const ENV = "production";
const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);

let clock = 1_000_000;
const now = () => clock;

function entry(agentId: string): AgentCatalogEntry {
  return {
    agentId,
    endpoint: `http://sre-agent-${agentId}.ns.svc`,
    owner: "sre-platform",
    description: agentId,
    enabled: true,
    environments: ["prod"],
    requiredRoles: ["infra-read"],
    allowedNeedsDomains: [],
    routing: { capabilities: [], exclusions: [] },
  };
}

function attestation(agentId: string, kind: AgentAttestation["kind"], overrides: Partial<AgentAttestation> = {}): AgentAttestation {
  return {
    agentName: agentId,
    environment: ENV,
    kind,
    envelopeGeneration: "10",
    envelopeDigest: DIGEST,
    ready: true,
    detail: "observed",
    observedAt: new Date(clock).toISOString(),
    ...overrides,
  };
}

/** An Agent that is activated, unsuspended and fully attested against DIGEST. */
async function healthy(): Promise<{ repo: MockAgentRepository; view: OperationalStateView }> {
  const repo = new MockAgentRepository();
  repo.activate({ agentName: "kafka", environment: ENV, suspended: false, replicaCeiling: 2, environmentsWithheld: [] });
  for (const kind of REQUIRED_ATTESTATIONS) repo.attest(attestation("kafka", kind));
  const view = new OperationalStateView(repo, ENV, { now });
  await view.refresh();
  return { repo, view };
}

describe("an Agent routes only when every term agrees", () => {
  it("routes when activated, unsuspended and attested against the current envelope", async () => {
    const { view } = await healthy();
    expect(view.decide("kafka", DIGEST, "prod").routable).toBe(true);
  });

  it("does not route without an activation record", async () => {
    // row existence IS the reviewed activation; absence is never permissive
    const view = new OperationalStateView(new MockAgentRepository(), ENV, { now });
    await view.refresh();
    const decision = view.decide("kafka", DIGEST, "prod");
    expect(decision.routable).toBe(false);
    expect(decision.reason).toMatch(/never been approved/u);
  });

  it("does not route while suspended, and says why", async () => {
    const { repo, view } = await healthy();
    await repo.suspend({ agentName: "kafka", environment: ENV, by: "alice", reason: "incident 4821" });
    await view.refresh();
    expect(view.decide("kafka", DIGEST, "prod")).toMatchObject({ routable: false });
    expect(view.decide("kafka", DIGEST, "prod").reason).toContain("incident 4821");
  });

  it.each(REQUIRED_ATTESTATIONS)("does not route when the %s attestation is missing", async (missing) => {
    const repo = new MockAgentRepository();
    repo.activate({ agentName: "kafka", environment: ENV, suspended: false, replicaCeiling: 1, environmentsWithheld: [] });
    for (const kind of REQUIRED_ATTESTATIONS) if (kind !== missing) repo.attest(attestation("kafka", kind));
    const view = new OperationalStateView(repo, ENV, { now });
    await view.refresh();
    // partial evidence is not evidence: all three must attest independently
    expect(view.decide("kafka", DIGEST, "prod").reason).toContain(`no ${missing} attestation`);
  });

  it("does not route when an attestation says not ready", async () => {
    const repo = new MockAgentRepository();
    repo.activate({ agentName: "kafka", environment: ENV, suspended: false, replicaCeiling: 1, environmentsWithheld: [] });
    for (const kind of REQUIRED_ATTESTATIONS) repo.attest(attestation("kafka", kind));
    repo.attest(attestation("kafka", "tool_access", { ready: false, detail: "cedar policy not applied" }));
    const view = new OperationalStateView(repo, ENV, { now });
    await view.refresh();
    expect(view.decide("kafka", DIGEST, "prod").reason).toContain("cedar policy not applied");
  });

  it("does not route on a zero replica ceiling", async () => {
    const repo = new MockAgentRepository();
    repo.activate({ agentName: "kafka", environment: ENV, suspended: false, replicaCeiling: 0, environmentsWithheld: [] });
    for (const kind of REQUIRED_ATTESTATIONS) repo.attest(attestation("kafka", kind));
    const view = new OperationalStateView(repo, ENV, { now });
    await view.refresh();
    expect(view.decide("kafka", DIGEST, "prod").reason).toMatch(/replica ceiling is zero/u);
  });
});

describe("resume restores only what is still approved", () => {
  it("does NOT become routable merely because the suspension was cleared", async () => {
    /*
     * THE CENTRAL PROPERTY. Git narrows the envelope while the Agent is
     * suspended. Resume clears one term; the attestations still describe the
     * OLD envelope, so the Agent stays out of the catalog until the reconciler
     * has observed it afresh against the new one.
     */
    const { repo, view } = await healthy();
    await repo.suspend({ agentName: "kafka", environment: ENV, by: "alice", reason: "incident" });
    await view.refresh();
    expect(view.decide("kafka", DIGEST, "prod").routable).toBe(false);

    // Git narrows: a new envelope digest, and no attestation against it yet
    await repo.resume({ agentName: "kafka", environment: ENV });
    await view.refresh();

    const decision = view.decide("kafka", OTHER_DIGEST, "prod");
    expect(decision.routable).toBe(false);
    expect(decision.reason).toMatch(/made against a different envelope/u);
  });

  it("returns only after the reconciler attests against the NEW envelope", async () => {
    const { repo, view } = await healthy();
    await repo.suspend({ agentName: "kafka", environment: ENV, by: "alice", reason: "incident" });
    await repo.resume({ agentName: "kafka", environment: ENV });
    await view.refresh();
    expect(view.decide("kafka", OTHER_DIGEST, "prod").routable).toBe(false);

    for (const kind of REQUIRED_ATTESTATIONS) {
      repo.attest(attestation("kafka", kind, { envelopeDigest: OTHER_DIGEST, envelopeGeneration: "11" }));
    }
    await view.refresh();
    expect(view.decide("kafka", OTHER_DIGEST, "prod").routable).toBe(true);
  });

  it("stays out when Git revoked the activation entirely while it was suspended", async () => {
    const { repo, view } = await healthy();
    await repo.suspend({ agentName: "kafka", environment: ENV, by: "alice", reason: "incident" });
    // the reconciler removes the row for an Agent Git no longer approves
    repo.deactivate("kafka", ENV);
    await view.refresh();
    expect(view.decide("kafka", DIGEST, "prod").reason).toMatch(/never been approved/u);
  });
});

describe("stale and replayed evidence", () => {
  it("treats an attestation older than its TTL as no evidence at all", async () => {
    const repo = new MockAgentRepository();
    repo.activate({ agentName: "kafka", environment: ENV, suspended: false, replicaCeiling: 1, environmentsWithheld: [] });
    for (const kind of REQUIRED_ATTESTATIONS) repo.attest(attestation("kafka", kind));
    const view = new OperationalStateView(repo, ENV, { now, attestationTtlMs: 60_000, snapshotTtlMs: 10 ** 9 });
    await view.refresh();
    expect(view.decide("kafka", DIGEST, "prod").routable).toBe(true);

    // a reconciler that stops running must degrade to not-routable, never to
    // permanently blessed
    clock += 120_000;
    expect(view.decide("kafka", DIGEST, "prod").reason).toMatch(/stale/u);
  });

  it("refuses an attestation replayed from an older generation", async () => {
    /*
     * A -> B -> A returns the original digest, so digest matching alone would
     * revalidate an attestation captured during the first A. The generation is
     * monotonic, so anything below the high-water mark is a replay.
     */
    const { repo, view } = await healthy();
    expect(view.decide("kafka", DIGEST, "prod").routable).toBe(true);

    for (const kind of REQUIRED_ATTESTATIONS) {
      repo.attest(attestation("kafka", kind, { envelopeGeneration: "4" }));
    }
    await view.refresh();
    expect(view.decide("kafka", DIGEST, "prod").reason).toMatch(/replay of an older envelope generation/u);
  });

  it("accepts a NEWER generation for the same digest", async () => {
    // a re-attestation of an unchanged envelope is normal and must not be
    // mistaken for a replay
    const { repo, view } = await healthy();
    for (const kind of REQUIRED_ATTESTATIONS) {
      repo.attest(attestation("kafka", kind, { envelopeGeneration: "99" }));
    }
    await view.refresh();
    expect(view.decide("kafka", DIGEST, "prod").routable).toBe(true);
  });
});

describe("the control plane itself", () => {
  it("is not routable before the first successful read", () => {
    const view = new OperationalStateView(new MockAgentRepository(), ENV, { now });
    expect(view.decide("kafka", DIGEST, "prod").reason).toMatch(/has not been read yet/u);
  });

  it("fails closed when the database is unavailable", async () => {
    const { view } = await healthy();
    expect(view.decide("kafka", DIGEST, "prod").routable).toBe(true);

    const broken = new OperationalStateView(
      { mode: "real", list: async () => [], get: async () => undefined, suspend: async () => {}, resume: async () => {}, attestations: async () => [], snapshot: async () => { throw new Error("ECONNREFUSED"); }, close: async () => {} },
      ENV,
      { now },
    );
    await broken.refresh();
    // falling back to Git alone would silently discard every suspension, which
    // is exactly the state an operator reached for in an incident
    expect(broken.decide("kafka", DIGEST, "prod").reason).toMatch(/unavailable|has not been read/u);
  });

  it("fails closed when the snapshot is too old to trust", async () => {
    const { view } = await healthy();
    clock += 10 * 60_000;
    expect(view.decide("kafka", DIGEST, "prod").reason).toMatch(/not been read recently enough/u);
  });
});

describe("the catalog wrapper", () => {
  const base = new StaticAgentCatalog([entry("kafka"), entry("keycloak")]);

  it("is the identity function when no control plane is configured", () => {
    /*
     * A deployment that has not adopted the operational plane must keep working
     * exactly as before. NOT CONFIGURED is a no-op; CONFIGURED BUT UNAVAILABLE
     * fails closed. Collapsing those two together would either break every
     * existing deployment or silently route during an outage.
     */
    const view = new OperationalStateView(new DisabledAgentRepository(), ENV, { now });
    const catalog = operationalCatalog(base, view, () => DIGEST, "prod");
    expect(catalog.listEnabled("prod").map((item) => item.agentId)).toEqual(["kafka", "keycloak"]);
  });

  it("removes an Agent the meet refuses, from listing AND from authorization", async () => {
    const { view } = await healthy();
    const catalog = operationalCatalog(base, view, () => DIGEST, "prod");
    // only kafka is activated; keycloak has no row
    expect(catalog.listEnabled("prod").map((item) => item.agentId)).toEqual(["kafka"]);
    // the authoritative pre-dispatch gate agrees, so a Round-2 follow-up cannot
    // reach an Agent that was never offered
    expect(catalog.filterAuthorized(["kafka", "keycloak"], ["infra-read"], "prod")).toEqual(["kafka"]);
  });

  it("still RESOLVES a refused Agent, so a real domain stays distinct from a typo", async () => {
    const { view } = await healthy();
    const catalog = operationalCatalog(base, view, () => DIGEST, "prod");
    expect(catalog.resolve("keycloak")).toBeDefined();
    expect(catalog.resolve("never-existed")).toBeUndefined();
  });

  it("refuses an Agent whose envelope cannot be resolved at all", async () => {
    const { view } = await healthy();
    // no digest means there is nothing to attest against
    const catalog = operationalCatalog(base, view, () => undefined, "prod");
    expect(catalog.listEnabled("prod")).toEqual([]);
  });
});

describe("environments are isolated", () => {
  it("does not let an activation in one environment route in another", async () => {
    /*
     * The row is keyed by (agent, environment) and the view is scoped to one
     * environment. An Agent activated in `staging` must be invisible to the
     * production resolver, or a lower-trust estate becomes a way into a higher
     * one.
     */
    const repo = new MockAgentRepository();
    repo.activate({ agentName: "kafka", environment: "staging", suspended: false, replicaCeiling: 2, environmentsWithheld: [] });
    for (const kind of REQUIRED_ATTESTATIONS) repo.attest(attestation("kafka", kind, { environment: "staging" }));

    const production = new OperationalStateView(repo, "production", { now });
    await production.refresh();
    expect(production.decide("kafka", DIGEST, "prod").reason).toMatch(/never been approved/u);

    const staging = new OperationalStateView(repo, "staging", { now });
    await staging.refresh();
    expect(staging.decide("kafka", DIGEST, "prod").routable).toBe(true);
  });

  it("suspending in one environment leaves the other running", async () => {
    const repo = new MockAgentRepository();
    for (const environment of ["production", "staging"]) {
      repo.activate({ agentName: "kafka", environment, suspended: false, replicaCeiling: 2, environmentsWithheld: [] });
      for (const kind of REQUIRED_ATTESTATIONS) repo.attest(attestation("kafka", kind, { environment }));
    }
    await repo.suspend({ agentName: "kafka", environment: "production", by: "alice", reason: "incident" });

    const production = new OperationalStateView(repo, "production", { now });
    const staging = new OperationalStateView(repo, "staging", { now });
    await Promise.all([production.refresh(), staging.refresh()]);

    expect(production.decide("kafka", DIGEST, "prod").routable).toBe(false);
    expect(staging.decide("kafka", DIGEST, "prod").routable).toBe(true);
  });
});

describe("the envelope digest", () => {
  const agent = {
    name: "kafka",
    owner: "sre-platform",
    systemPrompt: "Investigate Kafka.",
    spec: {
      type: "specialist" as const,
      lifecycle: "active" as const,
      model: { tier: "small" as const, profile: "tool-caller" },
      prompt: { systemFile: "config/prompts/kafka.md" },
      identity: { provider: "keycloak" as const, clientId: "sre-agent-kafka" },
      environments: ["prod"],
      routing: { capabilities: ["kafka"], exclusions: [] },
      access: [{ mcp: "kafka", audience: "sre-toolhive:kafka", tools: ["describe_topic"] }],
      execution: { maxToolCalls: 6, maxModelTurns: 6, timeoutMs: 120_000, maxEvidenceBytes: 262_144, maxContextTokens: 12_000, maxEvidenceItems: 32, maxRawExcerptBytes: 8192 },
      authorization: { requiredRoles: ["infra-read"] },
      security: { readOnly: true as const },
    },
  } as never;

  it("is stable for an unchanged envelope", () => {
    expect(envelopeDigest(agent, ENV)).toBe(envelopeDigest(agent, ENV));
  });

  it("changes when the PROMPT BODY changes", () => {
    // the body, not the path: a prompt edit keeps the same systemFile, and an
    // attestation surviving it is the resurrection path
    const edited = { ...(agent as object), systemPrompt: "Investigate Kafka differently." } as never;
    expect(envelopeDigest(edited, ENV)).not.toBe(envelopeDigest(agent, ENV));
  });

  it("changes when the environment changes", () => {
    // an observation made in staging must not validate production
    expect(envelopeDigest(agent, "staging")).not.toBe(envelopeDigest(agent, ENV));
  });

  it("changes when the deployment overlay changes", () => {
    const overlay = { apiVersion: "sre.ai/v1alpha1" as const, kind: "AgentDeployment" as const, agentId: "kafka", enabled: true };
    expect(envelopeDigest(agent, ENV, overlay)).not.toBe(envelopeDigest(agent, ENV));
    expect(envelopeDigest(agent, ENV, { ...overlay, enabled: false })).not.toBe(envelopeDigest(agent, ENV, overlay));
  });
});

describe("defects an adversarial review found", () => {
  it("withholds against the REQUESTED environment, not the deployment one", async () => {
    /*
     * These are different vocabularies: a runtime deployed as `production`
     * serves requests naming `prod`, `dr` or `lab`. Comparing the withheld list
     * against the deployment name meant withholding `prod` had no effect at all
     * while looking, in the row, exactly as though it did.
     */
    const repo = new MockAgentRepository();
    repo.activate({ agentName: "kafka", environment: ENV, suspended: false, replicaCeiling: 1, environmentsWithheld: ["prod"] });
    for (const kind of REQUIRED_ATTESTATIONS) repo.attest(attestation("kafka", kind));
    const view = new OperationalStateView(repo, ENV, { now });
    await view.refresh();

    expect(view.decide("kafka", DIGEST, "prod").reason).toMatch(/withheld from prod/u);
    // and another logical environment is unaffected
    expect(view.decide("kafka", DIGEST, "dr").routable).toBe(true);
  });

  it("refuses an attestation dated in the future", async () => {
    // `age > ttl` is false forever for a future date, so one write would make a
    // blessing permanent
    const repo = new MockAgentRepository();
    repo.activate({ agentName: "kafka", environment: ENV, suspended: false, replicaCeiling: 1, environmentsWithheld: [] });
    for (const kind of REQUIRED_ATTESTATIONS) {
      repo.attest(attestation("kafka", kind, { observedAt: new Date(clock + 5 * 365 * 24 * 3_600_000).toISOString() }));
    }
    const view = new OperationalStateView(repo, ENV, { now });
    await view.refresh();
    expect(view.decide("kafka", DIGEST, "prod").reason).toMatch(/dated in the future/u);
  });

  it("refuses a set of attestations from different reconciliation rounds", () => {
    /*
     * The reconciler writes all three under ONE generation. A set that
     * disagrees did not come from one round — either a reconciler crashed part
     * way (partial reconciliation) or one kind was replayed from an older
     * round. Neither may route.
     */
    const repo = new MockAgentRepository();
    repo.activate({ agentName: "kafka", environment: ENV, suspended: false, replicaCeiling: 1, environmentsWithheld: [] });
    repo.attest(attestation("kafka", "runtime", { envelopeGeneration: "11" }));
    repo.attest(attestation("kafka", "identity", { envelopeGeneration: "11" }));
    repo.attest(attestation("kafka", "tool_access", { envelopeGeneration: "10" }));
    const view = new OperationalStateView(repo, ENV, { now });
    return view.refresh().then(() => {
      expect(view.decide("kafka", DIGEST, "prod").reason).toMatch(/different reconciliation rounds/u);
    });
  });

  it("takes rows and attestations from ONE consistent read", async () => {
    /*
     * Two separate queries can straddle a commit: rows read before a suspension
     * lands, attestations after it — a snapshot the database never held, in
     * which an Agent is simultaneously unsuspended and freshly attested.
     */
    const repo = new MockAgentRepository();
    let snapshots = 0;
    const counting = { ...repo, mode: "real" as const, snapshot: async (environment: string) => { snapshots += 1; return repo.snapshot(environment); } };
    const view = new OperationalStateView(counting as never, ENV, { now });
    await view.refresh();
    expect(snapshots).toBe(1);
  });

  it("keeps a hung refresh from routing forever on an old snapshot", async () => {
    // a thrown refresh fails closed at once; a HUNG one leaves the previous
    // snapshot in place, so the snapshot TTL is what bounds it
    const { view } = await healthy();
    expect(view.decide("kafka", DIGEST, "prod").routable).toBe(true);
    clock += 31_000;
    expect(view.decide("kafka", DIGEST, "prod").reason).toMatch(/not been read recently enough/u);
  });
});

describe("A -> B -> A cannot replay an earlier round", () => {
  it("refuses a replayed attestation whose generation is behind the others", async () => {
    /*
     * Returning to a previous envelope returns to its DIGEST, so content
     * matching alone would revalidate an attestation captured during the first
     * visit — while the pod, the Keycloak client and the Cedar policy may still
     * be part way back.
     *
     * Two guards close it without a wall clock: the store refuses to overwrite
     * a newer generation with an older one, and the resolver refuses a set that
     * does not share a generation.
     */
    const repo = new MockAgentRepository();
    repo.activate({ agentName: "kafka", environment: ENV, suspended: false, replicaCeiling: 1, environmentsWithheld: [] });
    for (const kind of REQUIRED_ATTESTATIONS) repo.attest(attestation("kafka", kind, { envelopeGeneration: "12" }));
    const view = new OperationalStateView(repo, ENV, { now });
    await view.refresh();
    expect(view.decide("kafka", DIGEST, "prod").routable).toBe(true);

    // one kind replayed from the first visit to this envelope
    repo.attest(attestation("kafka", "tool_access", { envelopeGeneration: "10" }));
    await view.refresh();
    const decision = view.decide("kafka", DIGEST, "prod");
    expect(decision.routable).toBe(false);
    expect(decision.reason).toMatch(/replay of an older envelope generation|different reconciliation rounds/u);
  });
});
