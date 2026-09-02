import { describe, expect, it } from "vitest";
import { StaticAgentCatalog, type AgentCatalogEntry, type AgentDeploymentOverlay, type SpecialistAgentConfig } from "@sre/config";
import { MockAgentRepository, MockReconcilerStores, type AgentAttestation } from "@sre/orchestrator";
import { AgentReconciler, OperationalStateView, envelopeDigest, notVerified, singleAttester, REQUIRED_ATTESTATIONS } from "@sre/runtime-host";

/**
 * THE RECONCILER, and the authority it must never manufacture.
 *
 * It converges activations from the current reviewed Git envelope and records
 * what it actually verified. Everything below is a way it could quietly start
 * granting something nobody approved.
 */
const ENV = "production";

let clock = 2_000_000;
const now = () => clock;

function agent(name: string, lifecycle: "active" | "draft" = "active") {
  return {
    name,
    owner: "sre-platform",
    systemPrompt: `Investigate ${name}.`,
    spec: {
      type: "specialist" as const,
      lifecycle,
      model: { tier: "small" as const, profile: "tool-caller" },
      prompt: { systemFile: `config/prompts/${name}.md` },
      identity: { provider: "keycloak" as const, clientId: `sre-agent-${name}` },
      environments: ["prod"],
      routing: { capabilities: [name], exclusions: [] },
      access: [{ mcp: "wiki", audience: "sre-toolhive:wiki", tools: ["wiki_search"] }],
      execution: { maxToolCalls: 6, maxModelTurns: 6, timeoutMs: 120_000, maxEvidenceBytes: 262_144, maxContextTokens: 12_000, maxEvidenceItems: 32, maxRawExcerptBytes: 8192 },
      authorization: { requiredRoles: ["infra-read"] },
      security: { readOnly: true as const },
    },
  } as never;
}

function overlay(agentId: string, enabled: boolean): AgentDeploymentOverlay {
  return { apiVersion: "sre.ai/v1alpha1", kind: "AgentDeployment", agentId, enabled, replicas: 2 };
}

function entry(agentId: string): AgentCatalogEntry {
  return {
    agentId, endpoint: `http://sre-agent-${agentId}.ns.svc`, owner: "sre-platform", description: agentId,
    enabled: true, environments: ["prod"], requiredRoles: ["infra-read"], allowedNeedsDomains: [],
    routing: { capabilities: [], exclusions: [] },
  };
}

/** A desired-state source that can be steered, without touching a filesystem. */
function desiredState(options: { agents: Array<ReturnType<typeof agent>>; overlays: Map<string, AgentDeploymentOverlay>; error?: string; environment?: string }) {
  const specialists = options.agents;
  return {
    current: () => ({
      registry: { listSpecialists: () => specialists, getSpecialist: (id: string) => specialists.find((a) => (a as { name: string }).name === id) } as never,
      catalog: new StaticAgentCatalog(specialists.map((a) => entry((a as { name: string }).name))),
      environment: options.environment ?? ENV,
      enabledAgentIds: [],
      overlays: options.overlays,
      revision: "r1",
      loadedAt: new Date(clock).toISOString(),
      ...(options.error === undefined ? {} : { error: options.error }),
    }),
  } as never;
}

/**
 * A delegating view of the stores, with individual methods overridden.
 *
 * Spreading a class instance copies own enumerable properties only, so
 * `{ ...stores, x }` silently drops every prototype method — a stub that looks
 * complete and answers `undefined` to everything else.
 */
function storesWith(stores: MockReconcilerStores, overrides: Partial<MockReconcilerStores>) {
  return {
    listActivated: (environment: string) => stores.listActivated(environment),
    activate: (input: Parameters<MockReconcilerStores["activate"]>[0]) => stores.activate(input),
    deactivate: (agentName: string, environment: string) => stores.deactivate(agentName, environment),
    nextGeneration: () => stores.nextGeneration(),
    record: (attestation: AgentAttestation) => stores.record(attestation),
    invalidateStale: (environment: string, current: ReadonlyMap<string, string>) => stores.invalidateStale(environment, current),
    close: () => stores.close(),
    ...overrides,
  } as never;
}

function reconciler(state: ReturnType<typeof desiredState>, stores: MockReconcilerStores, extra: Record<string, unknown> = {}) {
  return new AgentReconciler({
    desiredState: state,
    environment: ENV,
    activation: stores,
    attestation: singleAttester(stores),
    runtimeProbe: { status: async () => ({ state: "ok", detail: "answered" }) },
    identity: { verify: async () => ({ ready: true, detail: "keycloak client reconciled" }) },
    toolAccess: { verify: async () => ({ ready: true, detail: "cedar policy applied" }) },
    now,
    ...extra,
  });
}

describe("activation follows the current reviewed envelope", () => {
  it("activates an Agent Git approves, and is idempotent", async () => {
    const repo = new MockAgentRepository();
    const stores = new MockReconcilerStores(repo);
    const state = desiredState({ agents: [agent("kafka")], overlays: new Map([["kafka", overlay("kafka", true)]]) });

    const first = await reconciler(state, stores).reconcile();
    expect(first.activated).toEqual(["kafka"]);
    const activatedAt = (await repo.get("kafka", ENV))?.activatedAt;

    // a second round must be a no-op, and must NOT move the activation epoch —
    // that epoch is what distinguishes a resume from a first activation
    const second = await reconciler(state, stores).reconcile();
    expect(second.activated).toEqual([]);
    expect((await repo.get("kafka", ENV))?.activatedAt).toBe(activatedAt);
  });

  it("does not activate a draft Agent, however it is deployed", async () => {
    const stores = new MockReconcilerStores(new MockAgentRepository());
    // lifecycle draft: the envelope exists but has never approved running
    const state = desiredState({ agents: [agent("kafka", "draft")], overlays: new Map([["kafka", overlay("kafka", true)]]) });
    expect((await reconciler(state, stores).reconcile()).activated).toEqual([]);
  });

  it("does not activate an Agent this environment does not enable", async () => {
    const stores = new MockReconcilerStores(new MockAgentRepository());
    const state = desiredState({ agents: [agent("kafka")], overlays: new Map([["kafka", overlay("kafka", false)]]) });
    expect((await reconciler(state, stores).reconcile()).activated).toEqual([]);
  });

  it("removes the activation when Git revokes the Agent", async () => {
    const repo = new MockAgentRepository();
    const stores = new MockReconcilerStores(repo);
    await reconciler(desiredState({ agents: [agent("kafka")], overlays: new Map([["kafka", overlay("kafka", true)]]) }), stores).reconcile();
    expect(await repo.get("kafka", ENV)).toBeDefined();

    // Git disables it; the activation must converge away
    const revoked = await reconciler(desiredState({ agents: [agent("kafka")], overlays: new Map([["kafka", overlay("kafka", false)]]) }), stores).reconcile();
    expect(revoked.deactivated).toEqual(["kafka"]);
    expect(await repo.get("kafka", ENV)).toBeUndefined();
  });

  it("does NOTHING AT ALL when desired state failed to load", async () => {
    /*
     * A snapshot carrying a reload error may predate a narrowing or a
     * revocation. Activating from it would be activation after revocation, and
     * attesting from it would bless an envelope that no longer exists.
     */
    const repo = new MockAgentRepository();
    const stores = new MockReconcilerStores(repo);
    const state = desiredState({ agents: [agent("kafka")], overlays: new Map([["kafka", overlay("kafka", true)]]), error: "schema validation failed" });

    const report = await reconciler(state, stores).reconcile();
    expect(report.skipped).toMatch(/did not load/u);
    expect(report.activated).toEqual([]);
    expect(report.generation).toBeUndefined();
    expect(await repo.get("kafka", ENV)).toBeUndefined();
  });

  it("refuses to write another environment's rows", async () => {
    const repo = new MockAgentRepository();
    const stores = new MockReconcilerStores(repo);
    // the desired state is for staging; this reconciler serves production
    const state = desiredState({ agents: [agent("kafka")], overlays: new Map([["kafka", overlay("kafka", true)]]), environment: "staging" });
    expect((await reconciler(state, stores).reconcile()).skipped).toMatch(/not production/u);
    expect(await repo.list("staging")).toEqual([]);
  });
});

describe("attestations record only what was verified", () => {
  it("writes all three subsystems independently, stamped with one generation", async () => {
    const repo = new MockAgentRepository();
    const stores = new MockReconcilerStores(repo);
    const state = desiredState({ agents: [agent("kafka")], overlays: new Map([["kafka", overlay("kafka", true)]]) });
    const report = await reconciler(state, stores).reconcile();

    expect(report.attested.map((item) => item.kind).sort()).toEqual([...REQUIRED_ATTESTATIONS].sort());
    const written = await repo.attestations(ENV);
    // ONE generation for the round: three stamps from two envelopes would each
    // be individually valid and together describe nothing
    expect(new Set(written.map((item) => item.envelopeGeneration)).size).toBe(1);
    expect(written.every((item) => item.envelopeGeneration === report.generation)).toBe(true);
  });

  it("stamps the digest of the envelope it actually verified", async () => {
    const repo = new MockAgentRepository();
    const stores = new MockReconcilerStores(repo);
    const kafka = agent("kafka");
    const state = desiredState({ agents: [kafka], overlays: new Map([["kafka", overlay("kafka", true)]]) });
    await reconciler(state, stores).reconcile();

    const expected = envelopeDigest(kafka, ENV, overlay("kafka", true));
    expect((await repo.attestations(ENV)).every((item) => item.envelopeDigest === expected)).toBe(true);
  });

  it("NEVER reports ready for a subsystem it did not verify", async () => {
    /*
     * The single most dangerous thing a reconciler could do: bless a subsystem
     * nobody looked at. An unconfigured verifier reports NOT ready with the
     * reason it could not look, so the Agent stays out of the catalog visibly.
     */
    const repo = new MockAgentRepository();
    const stores = new MockReconcilerStores(repo);
    const state = desiredState({ agents: [agent("kafka")], overlays: new Map([["kafka", overlay("kafka", true)]]) });

    await new AgentReconciler({
      desiredState: state, environment: ENV, activation: stores, attestation: singleAttester(stores), now,
      // nothing configured at all
    }).reconcile();

    const written = await repo.attestations(ENV);
    expect(written).toHaveLength(3);
    expect(written.every((item) => item.ready === false)).toBe(true);
    for (const item of written) expect(item.detail).toMatch(/no .* verifier is configured/u);
  });

  it("treats an `unknown` probe as NOT ready", async () => {
    // the probe looked and could not tell, which is a different thing from
    // having verified readiness
    const repo = new MockAgentRepository();
    const stores = new MockReconcilerStores(repo);
    const state = desiredState({ agents: [agent("kafka")], overlays: new Map([["kafka", overlay("kafka", true)]]) });
    await reconciler(state, stores, { runtimeProbe: { status: async () => ({ state: "unknown", detail: "nothing observed this" }) } }).reconcile();

    const runtime = (await repo.attestations(ENV)).find((item) => item.kind === "runtime");
    expect(runtime?.ready).toBe(false);
  });

  it("records a partial reconciliation honestly: one ready, another not", async () => {
    const repo = new MockAgentRepository();
    const stores = new MockReconcilerStores(repo);
    const state = desiredState({ agents: [agent("kafka")], overlays: new Map([["kafka", overlay("kafka", true)]]) });
    await reconciler(state, stores, { toolAccess: { verify: async () => ({ ready: false, detail: "cedar policy not applied yet" }) } }).reconcile();

    const written = await repo.attestations(ENV);
    expect(written.find((item) => item.kind === "runtime")?.ready).toBe(true);
    expect(written.find((item) => item.kind === "tool_access")?.ready).toBe(false);

    // and the resolver refuses the Agent on the strength of the one that failed
    const view = new OperationalStateView(repo, ENV, { now });
    await view.refresh();
    clock += 1;
    const digest = envelopeDigest(agent("kafka"), ENV, overlay("kafka", true));
    expect(view.decide("kafka", digest, "prod").reason).toContain("cedar policy not applied yet");
  });

  it("does not let one Agent's failure abort the round", async () => {
    // a single unreachable subsystem must not age the whole estate out of the
    // catalog
    const repo = new MockAgentRepository();
    const stores = new MockReconcilerStores(repo);
    const state = desiredState({
      agents: [agent("kafka"), agent("keycloak")],
      overlays: new Map([["kafka", overlay("kafka", true)], ["keycloak", overlay("keycloak", true)]]),
    });
    const report = await reconciler(state, stores, {
      identity: { verify: async (a: SpecialistAgentConfig) => { if (a.name === "kafka") throw new Error("idp unreachable"); return { ready: true, detail: "ok" }; } },
    }).reconcile();

    expect(report.failures.map((item) => item.agentName)).toEqual(["kafka"]);
    expect(report.attested.some((item) => item.agentName === "keycloak")).toBe(true);
  });
});

describe("generations are shared and ordered", () => {
  it("draws exactly one new generation per round, monotonically", async () => {
    const stores = new MockReconcilerStores(new MockAgentRepository());
    const state = desiredState({ agents: [agent("kafka")], overlays: new Map([["kafka", overlay("kafka", true)]]) });

    const first = await reconciler(state, stores).reconcile();
    const second = await reconciler(state, stores).reconcile();
    expect(BigInt(second.generation as string)).toBeGreaterThan(BigInt(first.generation as string));
  });

  it("keeps generations lossless past Number.MAX_SAFE_INTEGER", async () => {
    /*
     * PostgreSQL `bigint` exceeds what a JavaScript number can hold, and a
     * collapsed generation reads as "same generation" — the one wrong answer
     * here. The value is a decimal string end to end.
     */
    const huge = "9007199254740993"; // 2^53 + 1
    const repo = new MockAgentRepository();
    const stores = new MockReconcilerStores(repo);
    const state = desiredState({ agents: [agent("kafka")], overlays: new Map([["kafka", overlay("kafka", true)]]) });

    await new AgentReconciler({
      desiredState: state, environment: ENV,
      activation: stores,
      attestation: singleAttester(storesWith(stores, { nextGeneration: async () => huge, record: async (a: AgentAttestation) => { repo.attest(a); return true; } })),
      now,
    }).reconcile();

    const written = await repo.attestations(ENV);
    expect(written[0]?.envelopeGeneration).toBe(huge);
    expect(Number(written[0]?.envelopeGeneration)).not.toBe(Number.parseInt(huge, 10) - 1);
  });

  it("does not start a second round while one is in flight", async () => {
    // two overlapping rounds would draw two generations and could write them
    // out of order
    let generations = 0;
    const stores = new MockReconcilerStores(new MockAgentRepository());
    const state = desiredState({ agents: [agent("kafka")], overlays: new Map([["kafka", overlay("kafka", true)]]) });
    const instance = new AgentReconciler({
      desiredState: state, environment: ENV, activation: stores, now,
      attestation: singleAttester(storesWith(stores, { nextGeneration: async () => { generations += 1; return String(generations); } })),
    });
    await Promise.all([instance.reconcile(), instance.reconcile(), instance.reconcile()]);
    expect(generations).toBe(1);
  });
});

describe("the reconciler feeds the resolver end to end", () => {
  it("takes an Agent from merged to routable, and no further", async () => {
    const repo = new MockAgentRepository();
    const stores = new MockReconcilerStores(repo);
    const overlays = new Map([["kafka", overlay("kafka", true)]]);
    const state = desiredState({ agents: [agent("kafka")], overlays });
    const view = new OperationalStateView(repo, ENV, { now });
    const digest = envelopeDigest(agent("kafka"), ENV, overlay("kafka", true));

    // before any reconciliation: no activation, no attestation, not routable
    await view.refresh();
    expect(view.decide("kafka", digest, "prod").routable).toBe(false);

    // the resolver notes the envelope, then the reconciler attests after it
    clock += 1000;
    await reconciler(state, stores).reconcile();
    await view.refresh();
    expect(view.decide("kafka", digest, "prod").routable).toBe(true);
  });

  it("suspend cannot be bypassed by a reconciliation round", async () => {
    // the reconciler converges ACTIVATION and readiness; it holds no power over
    // the suspension, and a round must never clear one
    const repo = new MockAgentRepository();
    const stores = new MockReconcilerStores(repo);
    const state = desiredState({ agents: [agent("kafka")], overlays: new Map([["kafka", overlay("kafka", true)]]) });
    await reconciler(state, stores).reconcile();

    await repo.suspend({ agentName: "kafka", environment: ENV, by: "alice", reason: "incident" });
    clock += 1000;
    await reconciler(state, stores).reconcile();

    expect((await repo.get("kafka", ENV))?.suspended).toBe(true);
  });

  it("a Git narrowing invalidates the previous attestations until the next round", async () => {
    const repo = new MockAgentRepository();
    const stores = new MockReconcilerStores(repo);
    const kafka = agent("kafka");
    const overlays = new Map([["kafka", overlay("kafka", true)]]);
    await reconciler(desiredState({ agents: [kafka], overlays }), stores).reconcile();

    const view = new OperationalStateView(repo, ENV, { now });
    clock += 1000;
    await view.refresh();
    const before = envelopeDigest(kafka, ENV, overlay("kafka", true));
    expect(view.decide("kafka", before, "prod").routable).toBe(true);

    // Git narrows the prompt; the digest moves and the old stamps no longer apply
    const narrowed = { ...(kafka as object), systemPrompt: "Investigate kafka, narrowly." } as never;
    const after = envelopeDigest(narrowed, ENV, overlay("kafka", true));
    expect(view.decide("kafka", after, "prod").routable).toBe(false);

    // and it returns only once the reconciler has verified the NEW envelope
    clock += 1000;
    await reconciler(desiredState({ agents: [narrowed], overlays }), stores).reconcile();
    await view.refresh();
    expect(view.decide("kafka", after, "prod").routable).toBe(true);
  });
});

describe("notVerified", () => {
  it("is never ready, and always says which verifier is missing", () => {
    const result = notVerified("identity");
    expect(result.ready).toBe(false);
    expect(result.detail).toContain("identity");
  });
});

describe("defects an adversarial review found", () => {
  it("drops the old proof when the envelope changes, even if the round then fails", async () => {
    /*
     * A -> B -> A where B never completes.
     *
     * Overwriting per round is not enough: a round that loads B and fails
     * before writing leaves A's complete, still-fresh set in place, ready to
     * route again the moment Git returns to A. Invalidation happens FIRST, so
     * the change costs the old proof whether or not the round succeeds.
     */
    const repo = new MockAgentRepository();
    const stores = new MockReconcilerStores(repo);
    const kafka = agent("kafka");
    const overlays = new Map([["kafka", overlay("kafka", true)]]);
    await reconciler(desiredState({ agents: [kafka], overlays }), stores).reconcile();
    expect(await repo.attestations(ENV)).toHaveLength(3);

    // Git moves to B; every verifier then fails, so the round writes nothing
    const narrowed = { ...(kafka as object), systemPrompt: "Narrowed." } as never;
    const failing = reconciler(desiredState({ agents: [narrowed], overlays }), stores, {
      identity: { verify: async () => { throw new Error("idp unreachable"); } },
    });
    const report = await failing.reconcile();
    expect(report.failures).toHaveLength(1);

    // A's proof is gone regardless, so returning to A cannot reuse it
    expect(await repo.attestations(ENV)).toHaveLength(0);
  });

  it("clears attestations for an Agent Git has revoked", async () => {
    // otherwise the rows outlive the activation and wait for a re-approval of
    // the identical envelope
    const repo = new MockAgentRepository();
    const stores = new MockReconcilerStores(repo);
    const overlays = new Map([["kafka", overlay("kafka", true)]]);
    await reconciler(desiredState({ agents: [agent("kafka")], overlays }), stores).reconcile();
    expect(await repo.attestations(ENV)).toHaveLength(3);

    await reconciler(desiredState({ agents: [agent("kafka")], overlays: new Map([["kafka", overlay("kafka", false)]]) }), stores).reconcile();
    expect(await repo.attestations(ENV)).toHaveLength(0);
  });

  it("draws the generation BEFORE capturing desired state, so a stale round cannot win", async () => {
    /*
     * Drawing it after capture loses races: a round that captured A, paused,
     * and resumed after another had written B would draw a HIGHER generation
     * and overwrite B — the stale envelope winning on scheduling order.
     */
    const order: string[] = [];
    const stores = new MockReconcilerStores(new MockAgentRepository());
    const inner = desiredState({ agents: [agent("kafka")], overlays: new Map([["kafka", overlay("kafka", true)]]) }) as { current: () => unknown };
    const state = { current: () => { order.push("captured"); return inner.current(); } } as never;
    await new AgentReconciler({
      desiredState: state, environment: ENV, activation: stores, now,
      attestation: singleAttester(storesWith(stores, { nextGeneration: async () => { order.push("generation"); return stores.nextGeneration(); } })),
    }).reconcile();
    expect(order[0]).toBe("generation");
  });

  it("reports a discarded write instead of calling it a success", async () => {
    /*
     * A database restored to a lower sequence value makes every honest write
     * silently skipped. Reporting success would age the estate out of the
     * catalog with no error anywhere to explain it.
     */
    const stores = new MockReconcilerStores(new MockAgentRepository());
    const state = desiredState({ agents: [agent("kafka")], overlays: new Map([["kafka", overlay("kafka", true)]]) });
    const report = await new AgentReconciler({
      desiredState: state, environment: ENV, activation: stores, now,
      attestation: singleAttester(storesWith(stores, { record: async () => false })),
    }).reconcile();

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.error).toMatch(/superseded by a newer generation/u);
  });

  it("stamps each subsystem with the moment IT finished", async () => {
    /*
     * One shared timestamp let a fast READY be laundered into freshness by a
     * slow sibling: runtime answers at T, identity blocks for an hour, and
     * runtime is recorded as observed an hour later than it was.
     */
    const repo = new MockAgentRepository();
    const stores = new MockReconcilerStores(repo);
    const state = desiredState({ agents: [agent("kafka")], overlays: new Map([["kafka", overlay("kafka", true)]]) });

    /*
     * Explicitly ordered, so the property under test is the code's and not the
     * microtask queue's. The runtime probe schedules the identity release on a
     * MACROTASK, which runs only after every pending microtask — including the
     * continuation that stamps runtime's observation.
     */
    let releaseIdentity: () => void = () => {};
    const identityGate = new Promise<void>((resolve) => { releaseIdentity = resolve; });
    const round = reconciler(state, stores, {
      runtimeProbe: {
        status: async () => {
          setTimeout(releaseIdentity, 0);
          return { state: "ok", detail: "answered" };
        },
      },
      identity: { verify: async () => { await identityGate; clock += 3_600_000; return { ready: true, detail: "slow" }; } },
    }).reconcile();
    await round;

    const written = await repo.attestations(ENV);
    const runtime = written.find((item) => item.kind === "runtime");
    const identity = written.find((item) => item.kind === "identity");
    expect(Date.parse(identity?.observedAt as string)).toBeGreaterThan(Date.parse(runtime?.observedAt as string));
  });
});
