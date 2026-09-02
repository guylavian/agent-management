import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MockAgentRepository, DisabledAgentRepository, agentOperationalStateSchema } from "../src/index.ts";

/**
 * THE OPERATIONAL CONTROL PLANE, and the boundary it must not cross.
 *
 * Git holds the approved envelope. This holds only what narrows it. The tests
 * below are about the SHAPE of that power, not about convenience: each one
 * pins a property that `docs/architecture/hybrid-control-plane.md` claims and
 * that an implementation could quietly lose.
 */
const MIGRATION = readFileSync("../deploy/runtime/postgres/002_agent_operational_state.sql", "utf8");

const ACTIVE = {
  agentName: "kafka",
  environment: "production",
  suspended: false,
  replicaCeiling: 2,
  environmentsWithheld: [] as string[],
};

function repository(): MockAgentRepository {
  const repo = new MockAgentRepository();
  repo.activate({ ...ACTIVE });
  return repo;
}

describe("the schema cannot express a privilege increase", () => {
  it("has no field for anything the envelope owns", () => {
    /*
     * This is the load-bearing property. Not "validated on write" — ABSENT.
     * A check can be bypassed or forgotten; a missing field cannot. If someone
     * adds one of these, this test is the thing that should stop them and send
     * them to the document.
     */
    const fields = Object.keys(agentOperationalStateSchema.shape);
    for (const forbidden of ["access", "capabilities", "exclusions", "description", "displayName", "prompt", "identity", "model", "environments", "requiredRoles", "discovery", "lifecycle"]) {
      expect(fields, `operational state must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("offers no method that could activate an Agent", () => {
    // the interface is suspend/resume and reads. Creation is the reconciler's,
    // and it is deliberately not on AgentRepository at all.
    const repo: object = new DisabledAgentRepository();
    for (const method of ["activate", "create", "enable", "grant", "insert"]) {
      expect(Object.getPrototypeOf(repo), `AgentRepository must not expose ${method}`).not.toHaveProperty(method);
    }
  });

  it("refuses to suspend an Agent that was never activated", async () => {
    // mirrors the absent INSERT grant: suspending must not be a way to create
    // the activation row, or "suspend then resume" becomes first activation
    const repo = new MockAgentRepository();
    await expect(repo.suspend({ agentName: "ghost", environment: "production", by: "alice", reason: "x" }))
      .rejects.toThrow(/not activated/u);
    await expect(repo.resume({ agentName: "ghost", environment: "production" }))
      .rejects.toThrow(/not activated/u);
  });

  it("treats a missing row as never activated, not as permissive", async () => {
    const repo = new MockAgentRepository();
    expect(await repo.get("kafka", "production")).toBeUndefined();
    expect(await repo.list("production")).toEqual([]);
  });
});

describe("suspend and resume", () => {
  it("suspends immediately and records who and why", async () => {
    const repo = repository();
    await repo.suspend({ agentName: "kafka", environment: "production", by: "alice", reason: "incident 4821" });
    const row = await repo.get("kafka", "production");
    expect(row?.suspended).toBe(true);
    expect(row?.suspendedBy).toBe("alice");
    expect(row?.suspendedReason).toBe("incident 4821");
  });

  it("resume clears the suspension and NOTHING else", async () => {
    /*
     * Resume is not "make Active". It removes one term from the meet. Every
     * other narrowing term must survive it untouched, or resume becomes a way
     * to undo a withholding nobody asked to undo.
     */
    const repo = new MockAgentRepository();
    repo.activate({ ...ACTIVE, replicaCeiling: 1, environmentsWithheld: ["dr"] });
    await repo.suspend({ agentName: "kafka", environment: "production", by: "alice", reason: "incident" });
    await repo.resume({ agentName: "kafka", environment: "production" });

    const row = await repo.get("kafka", "production");
    expect(row?.suspended).toBe(false);
    expect(row?.replicaCeiling).toBe(1);
    expect(row?.environmentsWithheld).toEqual(["dr"]);
  });

  it("does not move the activation epoch when an Agent is re-activated", async () => {
    // the epoch is what distinguishes a resume from a first activation; a
    // reconciler pass that rewrote it would erase that distinction
    const repo = new MockAgentRepository();
    repo.activate({ ...ACTIVE, activatedAt: "2026-01-01T00:00:00.000Z" });
    const first = (await repo.get("kafka", "production"))?.activatedAt;
    repo.activate({ ...ACTIVE, activatedAt: "2026-06-01T00:00:00.000Z" });
    expect((await repo.get("kafka", "production"))?.activatedAt).toBe(first);
  });

  it("keeps environments a subtraction, never an addition", () => {
    // the field name says withheld, and the resolver intersects with the
    // envelope; there is no representation of "also allow this environment"
    const state = agentOperationalStateSchema.parse({ ...ACTIVE, activatedAt: new Date().toISOString(), environmentsWithheld: ["dr", "lab"] });
    expect(state.environmentsWithheld).toEqual(["dr", "lab"]);
    expect(Object.keys(state)).not.toContain("environmentsAllowed");
  });

  it("rejects a negative replica ceiling", () => {
    expect(() => agentOperationalStateSchema.parse({ ...ACTIVE, activatedAt: new Date().toISOString(), replicaCeiling: -1 })).toThrow();
  });
});

describe("the migration encodes the boundary in SQL, not in convention", () => {
  it("gives the management role UPDATE on the SUSPENSION columns only", () => {
    // application code is exactly what an attacker replaces, so the boundary
    // has to survive the application being wrong
    expect(MIGRATION).toMatch(/GRANT UPDATE \(suspended, suspended_reason, suspended_by, suspended_at\)\s*\n?\s*ON sre_agent_operational_state TO sre_management/u);
  });

  it("does not yet grant replica_ceiling or environments_withheld to anyone", () => {
    /*
     * Both are designed narrowing terms, but nothing operates them yet. An
     * ungranted column cannot be misused while it waits — and shipping the
     * grant ahead of the code that drives it is how a lever ends up in
     * production with no test behind it.
     */
    for (const line of MIGRATION.split("\n")) {
      if (!line.startsWith("GRANT UPDATE")) continue;
      expect(line, "no role should hold these columns yet").not.toContain("replica_ceiling");
      expect(line, "no role should hold these columns yet").not.toContain("environments_withheld");
    }
  });

  it("never grants the management role INSERT or DELETE on the state table", () => {
    // no INSERT means it cannot activate; no DELETE means it cannot shed a
    // suspension by removing the row
    const managementGrants = MIGRATION.split("\n").filter((line) => line.includes("TO sre_management") || line.includes("sre_management,"));
    for (const line of managementGrants) {
      if (!line.includes("sre_agent_operational_state")) continue;
      expect(line, "management must not hold INSERT/DELETE on operational state").not.toMatch(/GRANT[^(]*\b(INSERT|DELETE)\b/u);
    }
    expect(MIGRATION).toContain("GRANT INSERT, DELETE ON sre_agent_operational_state TO sre_activation");
  });

  it("splits activation from attestation into two roles", () => {
    // the architecture promises one stolen credential cannot both activate an
    // Agent and vouch for its readiness; a single role holding both grants
    // would make that promise false
    expect(MIGRATION).toContain("CREATE ROLE sre_activation");
    for (const role of ["sre_attest_runtime", "sre_attest_identity", "sre_attest_tool_access"]) {
      expect(MIGRATION).toContain(`CREATE ROLE ${role}`);
      // an attester may observe but never activate
      expect(MIGRATION).not.toMatch(new RegExp(`GRANT[^\\n]*INSERT[^\\n]*ON sre_agent_operational_state TO [^\\n]*${role}`, "u"));
    }
    // activation may create rows but never attest
    expect(MIGRATION).not.toMatch(/GRANT[^\n]*(INSERT|UPDATE)[^\n]*ON sre_agent_attestation TO sre_activation\b/u);
  });

  it("gives each subsystem its OWN attester, confined by row-level security", () => {
    /*
     * "Three independent attestations" is only true if three independent
     * credentials produce them. One attester role could write all three kinds
     * as ready and manufacture the entire routing proof by itself — three
     * checks that look independent and are one signature.
     */
    expect(MIGRATION).toContain("ENABLE ROW LEVEL SECURITY");
    expect(MIGRATION).toContain("FORCE ROW LEVEL SECURITY");
    for (const [role, kind] of [["sre_attest_runtime", "runtime"], ["sre_attest_identity", "identity"], ["sre_attest_tool_access", "tool_access"]]) {
      expect(MIGRATION).toMatch(new RegExp(`TO ${role} USING \\(kind = '${kind}'\\) WITH CHECK \\(kind = '${kind}'\\)`, "u"));
    }
  });

  it("refuses a generation the sequence never issued", () => {
    /*
     * Without this an attester could stamp the maximum bigint: forging an
     * ordering AND permanently blocking every honest lower-generation write,
     * a denial of service that looks like a healthy attestation.
     */
    expect(MIGRATION).toContain("sre_attestation_generation_is_issued");
    expect(MIGRATION).toMatch(/BEFORE INSERT OR UPDATE ON sre_agent_attestation/u);
    expect(MIGRATION).toMatch(/was never issued by the sequence/u);
  });

  it("writes audit with SECURITY DEFINER and a pinned search_path", () => {
    /*
     * As SECURITY INVOKER this trigger would fail on EVERY suspend and resume:
     * neither application role holds INSERT on the audit table, and they must
     * not — audit they could write is audit they could forge.
     *
     * The pinned search_path and the schema-qualified target close the standard
     * escape, where a temporary table of the same name shadows the real one.
     */
    expect(MIGRATION).toContain("SECURITY DEFINER");
    expect(MIGRATION).toContain("SET search_path = pg_catalog, public");
    expect(MIGRATION).toContain("INSERT INTO public.sre_agent_state_audit");
  });

  it("revokes before granting, so a re-run converges instead of accumulating", () => {
    // GRANT is additive: privilege drift from a hand-made grant during an
    // incident would otherwise survive every future migration
    expect(MIGRATION).toContain("REVOKE ALL ON sre_agent_operational_state FROM PUBLIC");
    expect(MIGRATION).toContain("REVOKE ALL ON sre_agent_attestation");
    expect(MIGRATION).toContain("REVOKE ALL ON sre_agent_state_audit");
  });

  it("makes the row identity immutable with a trigger, not a comment", () => {
    // without this, an UPDATE could repoint a row at a never-activated Agent —
    // first activation using only the UPDATE the API legitimately holds
    expect(MIGRATION).toContain("sre_agent_state_identity_is_immutable");
    expect(MIGRATION).toMatch(/BEFORE UPDATE ON sre_agent_operational_state/u);
    expect(MIGRATION).toMatch(/agent_name, environment and activated_at are immutable/u);
  });

  it("writes audit from the DATABASE, so a direct UPDATE cannot slip past it", () => {
    // audit that depends on the writer choosing to record itself is not audit
    expect(MIGRATION).toMatch(/AFTER INSERT OR UPDATE OR DELETE ON sre_agent_operational_state/u);
    expect(MIGRATION).toContain("sre_agent_state_audit");
    // and neither application role may write it directly
    expect(MIGRATION).not.toMatch(/GRANT[^\n]*INSERT[^\n]*ON sre_agent_state_audit TO sre_management/u);
  });

  it("gives attestations to the attesters alone", () => {
    // an observation any operational writer could set is not an observation
    expect(MIGRATION).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON sre_agent_attestation");
    expect(MIGRATION).not.toMatch(/GRANT[^\n]*(INSERT|UPDATE)[^\n]*ON sre_agent_attestation TO sre_management\b/u);
  });

  it("stamps attestations with a generation as well as a digest", () => {
    // a content digest alone lets A -> B -> A replay an old observation
    expect(MIGRATION).toContain("envelope_generation");
    expect(MIGRATION).toContain("envelope_digest");
  });

  it("keys the operational row by agent AND environment", () => {
    // a single-column key would let one shared database hold the activation of
    // an Agent in only one environment, silently
    expect(MIGRATION).toContain("PRIMARY KEY (agent_name, environment)");
  });

  it("cannot store anything the envelope owns", () => {
    const table = MIGRATION.slice(MIGRATION.indexOf("CREATE TABLE IF NOT EXISTS sre_agent_operational_state"));
    const columns = table.slice(0, table.indexOf(");"));
    for (const forbidden of ["access", "capabilit", "prompt", "identity", "model", "required_roles", "discovery", "lifecycle"]) {
      expect(columns, `operational state must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });
});
