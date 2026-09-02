import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StaticAgentCatalog, type AgentCatalogEntry, type AgentDeploymentOverlay } from "@sre/config";
import { PostgresActivationStore, PostgresAgentRepository, PostgresAttestationStore } from "@sre/orchestrator";
import { AgentReconciler, OperationalStateView, envelopeDigest, operationalCatalog } from "@sre/runtime-host";

/**
 * THE OPERATIONAL PLANE, AGAINST A REAL POSTGRESQL.
 *
 * Every other test in this area asserts the SQL by reading it as text. That
 * proves the migration SAYS the right thing; it cannot prove PostgreSQL AGREES.
 * The grants, the row-level security, the immutability trigger, the audit
 * trigger and the `ON CONFLICT ... WHERE` guard are all enforcement this
 * platform is relying on, and none of them had ever been executed.
 *
 * So this one connects as the ACTUAL roles — management, activation, and the
 * three attesters — and walks the whole lifecycle:
 *
 *   activation → three independent attestations → routable
 *              → suspend → not routable
 *              → resume  → still not routable until re-verified
 *              → fresh reconciliation → routable
 *
 * Skipped, loudly, when no database is available. It is never silently green:
 * `SRE_TEST_POSTGRES_URL` points at a throwaway instance, e.g.
 *
 *   docker run -d --name sre-test-pg -e POSTGRES_PASSWORD=testpw \
 *     -e POSTGRES_DB=sre -e PGDATA=/pgdata --tmpfs /pgdata:rw,size=512m \
 *     -p 55432:5432 postgres:16-alpine -c fsync=off
 *   SRE_TEST_POSTGRES_URL=postgres://postgres:testpw@127.0.0.1:55432/sre
 */

const SUPERUSER = process.env.SRE_TEST_POSTGRES_URL;
const ENV = "production";
const MIGRATION = readFileSync("../deploy/runtime/postgres/002_agent_operational_state.sql", "utf8");

/** A login role per privilege domain, so the boundary under test is the real one. */
const LOGINS = {
  management: "app_management",
  activation: "app_activation",
  runtime: "app_attest_runtime",
  identity: "app_attest_identity",
  tool_access: "app_attest_tool_access",
} as const;

const MEMBERSHIP: Record<keyof typeof LOGINS, string> = {
  management: "sre_management",
  activation: "sre_activation",
  runtime: "sre_attest_runtime",
  identity: "sre_attest_identity",
  tool_access: "sre_attest_tool_access",
};

function urlFor(login: string): string {
  const base = new URL(SUPERUSER as string);
  base.username = login;
  base.password = "testpw";
  return base.toString();
}

function agent(name: string) {
  return {
    name, owner: "sre-platform", systemPrompt: `Investigate ${name}.`,
    spec: {
      type: "specialist" as const, lifecycle: "active" as const,
      model: { tier: "small" as const, profile: "tool-caller" },
      prompt: { systemFile: `config/prompts/${name}.md` },
      identity: { provider: "keycloak" as const, clientId: `sre-agent-${name}` },
      environments: ["prod"], routing: { capabilities: [name], exclusions: [] },
      access: [{ mcp: "wiki", audience: "sre-toolhive:wiki", tools: ["wiki_search"] }],
      execution: { maxToolCalls: 6, maxModelTurns: 6, timeoutMs: 120_000, maxEvidenceBytes: 262_144, maxContextTokens: 12_000, maxEvidenceItems: 32, maxRawExcerptBytes: 8192 },
      authorization: { requiredRoles: ["infra-read"] }, security: { readOnly: true as const },
    },
  } as never;
}

const OVERLAY: AgentDeploymentOverlay = { apiVersion: "sre.ai/v1alpha1", kind: "AgentDeployment", agentId: "kafka", enabled: true, replicas: 2 };

function entry(agentId: string): AgentCatalogEntry {
  return {
    agentId, endpoint: `http://sre-agent-${agentId}.ns.svc`, owner: "sre-platform", description: agentId,
    enabled: true, environments: ["prod"], requiredRoles: ["infra-read"], allowedNeedsDomains: [],
    routing: { capabilities: [], exclusions: [] },
  };
}

let overlayEnabled = true;
let promptBody = "Investigate kafka.";

function desiredState() {
  const kafka = { ...(agent("kafka") as object), systemPrompt: promptBody } as never;
  return {
    current: () => ({
      registry: { listSpecialists: () => [kafka], getSpecialist: () => kafka } as never,
      catalog: new StaticAgentCatalog([entry("kafka")]),
      environment: ENV,
      enabledAgentIds: ["kafka"],
      overlays: new Map([["kafka", { ...OVERLAY, enabled: overlayEnabled }]]),
      revision: "r1",
      loadedAt: new Date().toISOString(),
    }),
  } as never;
}

function currentDigest(): string {
  const kafka = { ...(agent("kafka") as object), systemPrompt: promptBody } as never;
  return envelopeDigest(kafka, ENV, { ...OVERLAY, enabled: overlayEnabled });
}

const describeOrSkip = SUPERUSER === undefined ? describe.skip : describe;

describeOrSkip("the operational plane against a real PostgreSQL", () => {
  let admin: Pool;
  let repository: PostgresAgentRepository;
  let activation: PostgresActivationStore;
  const attesters: Record<"runtime" | "identity" | "tool_access", PostgresAttestationStore> = {} as never;
  let view: OperationalStateView;

  beforeAll(async () => {
    admin = new Pool({ connectionString: SUPERUSER });
    await admin.query(MIGRATION);
    for (const [domain, login] of Object.entries(LOGINS)) {
      // a LOGIN role that is merely a MEMBER of the privilege role: it owns
      // nothing, so `FORCE ROW LEVEL SECURITY` applies to it as it would in a
      // real deployment
      await admin.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${login}') THEN
          CREATE ROLE ${login} LOGIN PASSWORD 'testpw';
        END IF;
      END $$;`);
      await admin.query(`GRANT ${MEMBERSHIP[domain as keyof typeof LOGINS]} TO ${login}`);
    }
    await admin.query("TRUNCATE sre_agent_attestation, sre_agent_operational_state, sre_agent_state_audit");

    repository = new PostgresAgentRepository(urlFor(LOGINS.management));
    activation = new PostgresActivationStore(urlFor(LOGINS.activation));
    for (const kind of ["runtime", "identity", "tool_access"] as const) {
      attesters[kind] = new PostgresAttestationStore(urlFor(LOGINS[kind]));
    }
    view = new OperationalStateView(repository, ENV, { attestationTtlMs: 600_000, snapshotTtlMs: 600_000 });
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([
      repository?.close(), activation?.close(),
      ...Object.values(attesters).map((store) => store.close()),
    ]);
    await admin?.end();
  });

  function reconciler(ready = true) {
    return new AgentReconciler({
      desiredState: desiredState(),
      environment: ENV,
      activation,
      attestation: attesters,
      runtimeProbe: { status: async () => ({ state: ready ? "ok" : "degraded", detail: ready ? "answered" : "no answer" }) },
      identity: { verify: async () => ({ ready: true, detail: "keycloak client reconciled" }) },
      toolAccess: { verify: async () => ({ ready: true, detail: "cedar policy applied" }) },
    });
  }

  it("walks activation → three attestations → routable → suspend → resume → re-verified → routable", async () => {
    const catalog = operationalCatalog(new StaticAgentCatalog([entry("kafka")]), view, () => currentDigest(), "prod");

    // ── nothing yet: no activation row, so not routable ──────────────────────
    await view.refresh();
    expect(view.decide("kafka", currentDigest(), "prod").reason).toMatch(/never been approved/u);

    // ── reconcile: activation + three attestations from three roles ─────────
    const first = await reconciler().reconcile();
    expect(first.activated).toEqual(["kafka"]);
    expect(first.failures).toEqual([]);
    expect(first.attested).toHaveLength(3);

    const written = await admin.query<{ kind: string; ready: boolean; envelope_generation: string }>(
      "SELECT kind, ready, envelope_generation FROM sre_agent_attestation WHERE agent_name = 'kafka' ORDER BY kind",
    );
    expect(written.rows.map((row) => row.kind)).toEqual(["identity", "runtime", "tool_access"]);
    expect(written.rows.every((row) => row.ready)).toBe(true);
    // one round, one generation
    expect(new Set(written.rows.map((row) => row.envelope_generation)).size).toBe(1);

    await view.refresh();
    expect(view.decide("kafka", currentDigest(), "prod").routable).toBe(true);
    expect(catalog.listEnabled("prod").map((item) => item.agentId)).toEqual(["kafka"]);

    // ── suspend: immediate, through the management role only ────────────────
    await repository.suspend({ agentName: "kafka", environment: ENV, by: "alice", reason: "incident 4821" });
    await view.refresh();
    expect(view.decide("kafka", currentDigest(), "prod").reason).toContain("incident 4821");
    expect(catalog.listEnabled("prod")).toEqual([]);

    // ── Git narrows while suspended, so the old proof no longer applies ──────
    promptBody = "Investigate kafka, narrowly.";
    await repository.resume({ agentName: "kafka", environment: ENV });
    await view.refresh();

    /*
     * THE CENTRAL PROPERTY. Resume cleared one term and nothing else: the
     * attestations still describe the previous envelope, so the Agent is NOT
     * routable merely because the suspension is gone.
     */
    const afterResume = view.decide("kafka", currentDigest(), "prod");
    expect(afterResume.routable).toBe(false);
    expect(afterResume.reason).toMatch(/different envelope/u);

    // ── fresh reconciliation against the NEW envelope ────────────────────────
    const second = await reconciler().reconcile();
    expect(second.failures).toEqual([]);
    await view.refresh();
    expect(view.decide("kafka", currentDigest(), "prod").routable).toBe(true);
  }, 60_000);

  it("recorded every state change in the audit table, written by the database", async () => {
    // the trigger, not the application: a direct UPDATE must not slip past it
    const audit = await admin.query<{ action: string }>(
      "SELECT action FROM sre_agent_state_audit WHERE agent_name = 'kafka' ORDER BY id",
    );
    expect(audit.rows.map((row) => row.action)).toEqual(expect.arrayContaining(["INSERT", "UPDATE"]));
  });

  describe("the privilege boundary, as PostgreSQL actually enforces it", () => {
    it("refuses to let the management role activate an Agent", async () => {
      const pool = new Pool({ connectionString: urlFor(LOGINS.management) });
      try {
        await expect(pool.query(
          "INSERT INTO sre_agent_operational_state(agent_name, environment, replica_ceiling) VALUES ('ghost','production',1)",
        )).rejects.toThrow(/permission denied/iu);
      } finally { await pool.end(); }
    });

    it("refuses to let the management role delete a suspension by dropping the row", async () => {
      const pool = new Pool({ connectionString: urlFor(LOGINS.management) });
      try {
        await expect(pool.query("DELETE FROM sre_agent_operational_state WHERE agent_name = 'kafka'"))
          .rejects.toThrow(/permission denied/iu);
      } finally { await pool.end(); }
    });

    it("refuses to let the management role change row identity", async () => {
      // the column grant stops it before the trigger even runs
      const pool = new Pool({ connectionString: urlFor(LOGINS.management) });
      try {
        await expect(pool.query("UPDATE sre_agent_operational_state SET agent_name = 'other' WHERE agent_name = 'kafka'"))
          .rejects.toThrow(/permission denied/iu);
      } finally { await pool.end(); }
    });

    it("confines each attester to its OWN subsystem", async () => {
      /*
       * The critical one. A single credential able to write all three kinds
       * could manufacture the entire routing proof by itself — three checks
       * that look independent and are one signature.
       */
      const pool = new Pool({ connectionString: urlFor(LOGINS.runtime) });
      try {
        await expect(pool.query(
          `INSERT INTO sre_agent_attestation(agent_name, environment, kind, envelope_generation, envelope_digest, ready, detail)
           VALUES ('kafka','production','identity',1,'x',true,'forged')`,
        )).rejects.toThrow(/row-level security/iu);
      } finally { await pool.end(); }
    });

    it("refuses a generation the sequence never issued", async () => {
      // the maximum bigint would forge an ordering AND block every honest
      // lower-generation write for ever
      const pool = new Pool({ connectionString: urlFor(LOGINS.runtime) });
      try {
        await expect(pool.query(
          `INSERT INTO sre_agent_attestation(agent_name, environment, kind, envelope_generation, envelope_digest, ready, detail)
           VALUES ('kafka','production','runtime',9223372036854775807,'x',true,'forged')
           ON CONFLICT (agent_name, environment, kind) DO UPDATE SET envelope_generation = EXCLUDED.envelope_generation`,
        )).rejects.toThrow(/never issued by the sequence/u);
      } finally { await pool.end(); }
    });

    it("silently discards an attestation from an older generation, and says so", async () => {
      // `ON CONFLICT ... WHERE` returns success with zero rows; reporting that
      // as a successful write is how a restored database ages the estate out
      const current = await admin.query<{ envelope_generation: string }>(
        "SELECT envelope_generation FROM sre_agent_attestation WHERE agent_name='kafka' AND kind='runtime'",
      );
      const older = (BigInt(current.rows[0]?.envelope_generation as string) - 1n).toString();
      const applied = await attesters.runtime.record({
        agentName: "kafka", environment: ENV, kind: "runtime",
        envelopeGeneration: older, envelopeDigest: "stale", ready: true,
        detail: "replayed", observedAt: new Date().toISOString(),
      });
      expect(applied).toBe(false);
    });
  });
});
