-- OPERATIONAL CONTROL PLANE for Agents.
--
-- Git holds the approved envelope: identity, tool access, prompt, routing text,
-- environments, model, limits. This schema holds only what can NARROW that
-- envelope, plus observations of the world.
--
-- The security property is structural, not procedural: there is no column here
-- for access, capabilities, prompt, identity, model, environments or roles, so
-- no UPDATE — mistaken, malicious or automated — can express a privilege
-- increase. A check can be bypassed or forgotten. A missing column cannot.
--
-- See docs/architecture/hybrid-control-plane.md.

-- ---------------------------------------------------------------------------
-- Roles. The privilege boundary is a GRANT, not a convention in application
-- code, because application code is exactly what an attacker replaces.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- the management API: may narrow, may never activate
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sre_management') THEN
    CREATE ROLE sre_management NOLOGIN;
  END IF;
  -- TWO reconciler identities, not one. The architecture promises that a single
  -- stolen credential cannot both activate an Agent and vouch for its
  -- readiness; one role holding both grants would make that promise false.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sre_activation') THEN
    CREATE ROLE sre_activation NOLOGIN;
  END IF;
  /*
   * THREE attestation identities, one per subsystem.
   *
   * "Three independent attestations" is only true if three independent
   * credentials produce them. A single attester role could write all three
   * kinds as ready and manufacture the entire routing proof by itself — the
   * three checks would look independent and be one signature.
   *
   * Row-level security below confines each role to its own `kind`.
   */
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sre_attest_runtime') THEN
    CREATE ROLE sre_attest_runtime NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sre_attest_identity') THEN
    CREATE ROLE sre_attest_identity NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sre_attest_tool_access') THEN
    CREATE ROLE sre_attest_tool_access NOLOGIN;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- One row per ACTIVATED Agent.
--
-- ROW EXISTENCE IS THE REVIEWED ACTIVATION. A missing row means the Agent has
-- never been approved to run here, and resolves to not-routable. That is why
-- only the reconciler may INSERT: it creates a row solely as a projection of a
-- merged, reviewed Git fact (lifecycle: active + enabled in this environment).
--
-- Existence is NECESSARY but not SUFFICIENT: the resolver still conjoins it
-- with the live Git envelope, so a row for an Agent Git no longer approves
-- grants nothing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sre_agent_operational_state (
  -- COMPOSITE: the same Agent is activated independently per environment, and a
  -- single-column key would let one shared database hold only one of them
  agent_name            text        NOT NULL,
  environment           text        NOT NULL,
  -- written once by the reconciler; the activation epoch
  activated_at          timestamptz NOT NULL DEFAULT NOW(),

  -- the narrowing terms, and the only things the management API may write
  suspended             boolean     NOT NULL DEFAULT false,
  suspended_reason      text,
  suspended_by          text,
  suspended_at          timestamptz,

  -- NOT NULL matters: a nullable ceiling would make the first NULL -> 1 update
  -- indistinguishable from an activation. There is no null to promote.
  replica_ceiling       integer     NOT NULL DEFAULT 0 CHECK (replica_ceiling >= 0),

  -- may only ever SUBTRACT from the envelope's environments
  environments_withheld text[]      NOT NULL DEFAULT '{}',

  updated_at            timestamptz NOT NULL DEFAULT NOW(),

  PRIMARY KEY (agent_name, environment)
);

-- ---------------------------------------------------------------------------
-- The identity of a row may never change.
--
-- Without this, an UPDATE could repoint an existing row at a never-activated
-- Agent — first activation through the side door, using only the UPDATE the
-- management API legitimately holds.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sre_agent_state_identity_is_immutable() RETURNS trigger
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.agent_name IS DISTINCT FROM OLD.agent_name
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
    RAISE EXCEPTION 'agent_name, environment and activated_at are immutable (attempted % -> %)', OLD.agent_name, NEW.agent_name
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sre_agent_state_identity ON sre_agent_operational_state;
CREATE TRIGGER sre_agent_state_identity
  BEFORE UPDATE ON sre_agent_operational_state
  FOR EACH ROW EXECUTE FUNCTION sre_agent_state_identity_is_immutable();

-- ---------------------------------------------------------------------------
-- Attestations, stamped with the envelope they were observed against.
--
-- A bare boolean is a resurrection path: narrow an Agent's access in Git while
-- it is suspended, resume it, and a stale `ready = true` blesses a pod, a
-- Keycloak client and a Cedar policy that all still reflect the OLD envelope.
--
-- The stamp is (generation, digest). A content digest alone is not enough:
-- A -> B -> A returns the original digest, so an attestation from the first A
-- would silently validate the second. The generation is the monotonic commit
-- identity, so equal content at an older generation is stale.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sre_agent_attestation (
  agent_name          text        NOT NULL,
  environment         text        NOT NULL,
  -- runtime | identity | tool_access
  kind                text        NOT NULL CHECK (kind IN ('runtime', 'identity', 'tool_access')),
  envelope_generation bigint      NOT NULL,
  envelope_digest     text        NOT NULL,
  ready               boolean     NOT NULL,
  detail              text        NOT NULL,
  observed_at         timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_name, environment, kind)
);

CREATE INDEX IF NOT EXISTS sre_agent_attestation_freshness_idx
  ON sre_agent_attestation (observed_at);

-- The monotonic half of the stamp.
--
-- A content digest alone cannot order anything: A -> B -> A returns the
-- original digest, so an attestation from the first A would validate the
-- second. A SEQUENCE gives every attestation round a strictly increasing
-- number that all replicas agree on, so the resolver can refuse anything
-- below the highest generation it has already accepted for that Agent.
--
-- Shared, because a per-process counter would have each replica rejecting the
-- others' attestations.
CREATE SEQUENCE IF NOT EXISTS sre_envelope_generation_seq AS bigint START WITH 1;

/*
 * A generation must be one the SEQUENCE actually issued.
 *
 * Without this an attester could stamp `9223372036854775807`, which not only
 * forges an ordering but permanently blocks every honest lower-generation
 * write — a denial of service that looks like a healthy attestation. `CHECK`
 * cannot contain a subquery, so this is a trigger.
 */
CREATE OR REPLACE FUNCTION sre_attestation_generation_is_issued() RETURNS trigger
  -- DEFINER: reading `last_value` needs SELECT on the sequence, and an attester
  -- holds only USAGE. Granting SELECT would let it read the ordering it is
  -- being constrained by; the check runs with the owner's rights instead.
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE issued bigint;
BEGIN
  SELECT last_value INTO issued FROM public.sre_envelope_generation_seq;
  IF NEW.envelope_generation > issued THEN
    RAISE EXCEPTION 'envelope_generation % was never issued by the sequence (last issued %)', NEW.envelope_generation, issued
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sre_attestation_generation ON sre_agent_attestation;
CREATE TRIGGER sre_attestation_generation
  BEFORE INSERT OR UPDATE ON sre_agent_attestation
  FOR EACH ROW EXECUTE FUNCTION sre_attestation_generation_is_issued();

/*
 * Each attester may touch ONLY its own subsystem's rows.
 *
 * This is what makes the three attestations independent rather than three
 * columns written by one credential.
 */
ALTER TABLE sre_agent_attestation ENABLE ROW LEVEL SECURITY;
ALTER TABLE sre_agent_attestation FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sre_attest_runtime_own_kind ON sre_agent_attestation;
CREATE POLICY sre_attest_runtime_own_kind ON sre_agent_attestation
  TO sre_attest_runtime USING (kind = 'runtime') WITH CHECK (kind = 'runtime');

DROP POLICY IF EXISTS sre_attest_identity_own_kind ON sre_agent_attestation;
CREATE POLICY sre_attest_identity_own_kind ON sre_agent_attestation
  TO sre_attest_identity USING (kind = 'identity') WITH CHECK (kind = 'identity');

DROP POLICY IF EXISTS sre_attest_tool_access_own_kind ON sre_agent_attestation;
CREATE POLICY sre_attest_tool_access_own_kind ON sre_agent_attestation
  TO sre_attest_tool_access USING (kind = 'tool_access') WITH CHECK (kind = 'tool_access');

-- readers see every kind; they cannot write any of them
DROP POLICY IF EXISTS sre_attestation_readable ON sre_agent_attestation;
CREATE POLICY sre_attestation_readable ON sre_agent_attestation
  FOR SELECT TO sre_management, sre_activation USING (true);

-- ---------------------------------------------------------------------------
-- Audit, written by the DATABASE rather than by the application's good
-- behaviour.
--
-- A direct UPDATE bypasses any event the API would have inserted and any span
-- it would have emitted. Audit that depends on the writer choosing to record
-- itself is not audit, so the trigger below records every change to the
-- operational row whatever made it.
--
-- Honest scope: this is append-only against the APPLICATION roles, not against
-- the table owner, the migration role or a DBA. Tamper-evidence against those
-- requires shipping off-box, which is what draining this outbox to
-- OpenTelemetry is for. This table is a queryable convenience, not the system
-- of record.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sre_agent_state_audit (
  id           bigserial   PRIMARY KEY,
  agent_name   text        NOT NULL,
  environment  text        NOT NULL,
  action       text        NOT NULL,
  before_state jsonb,
  after_state  jsonb,
  db_user      text        NOT NULL DEFAULT CURRENT_USER,
  occurred_at  timestamptz NOT NULL DEFAULT NOW(),
  -- drained to OpenTelemetry; NULL means not yet exported
  exported_at  timestamptz
);

CREATE INDEX IF NOT EXISTS sre_agent_state_audit_outbox_idx
  ON sre_agent_state_audit (exported_at) WHERE exported_at IS NULL;

-- SECURITY DEFINER, deliberately: neither application role holds INSERT on the
-- audit table, and they must not — audit they could write is audit they could
-- forge. As SECURITY INVOKER this function would instead make every suspend and
-- resume fail with a permission error inside the trigger.
--
-- `search_path` is pinned and the table is schema-qualified so the target
-- cannot be shadowed by a temporary table of the same name, which is the
-- standard escape from a SECURITY DEFINER function.
CREATE OR REPLACE FUNCTION sre_agent_state_audit_write() RETURNS trigger
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.sre_agent_state_audit(agent_name, environment, action, before_state, after_state)
  VALUES (
    COALESCE(NEW.agent_name, OLD.agent_name),
    COALESCE(NEW.environment, OLD.environment),
    TG_OP,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END
  );
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sre_agent_state_audit_trigger ON sre_agent_operational_state;
CREATE TRIGGER sre_agent_state_audit_trigger
  AFTER INSERT OR UPDATE OR DELETE ON sre_agent_operational_state
  FOR EACH ROW EXECUTE FUNCTION sre_agent_state_audit_write();

-- ---------------------------------------------------------------------------
-- Grants. THIS is the boundary.
--
-- Re-running this migration must CONVERGE the boundary, not merely add to it.
-- `GRANT` is additive, so privilege drift — a grant made by hand during an
-- incident, an old ACL from a previous revision — would survive forever. Every
-- privilege is therefore revoked first and re-granted from scratch.
-- ---------------------------------------------------------------------------
REVOKE ALL ON sre_agent_operational_state FROM PUBLIC, sre_management, sre_activation, sre_attest_runtime, sre_attest_identity, sre_attest_tool_access;
REVOKE ALL ON sre_agent_attestation        FROM PUBLIC, sre_management, sre_activation, sre_attest_runtime, sre_attest_identity, sre_attest_tool_access;
REVOKE ALL ON sre_agent_state_audit        FROM PUBLIC, sre_management, sre_activation, sre_attest_runtime, sre_attest_identity, sre_attest_tool_access;
REVOKE ALL ON SEQUENCE sre_agent_state_audit_id_seq FROM PUBLIC, sre_management, sre_activation, sre_attest_runtime, sre_attest_identity, sre_attest_tool_access;

-- The management API: suspend and resume, and nothing else.
--
-- It holds no INSERT, so it cannot activate; no DELETE, so it cannot shed a
-- suspension by removing the row; and column-level UPDATE on the suspension
-- columns ONLY, so it cannot touch row identity even if the immutability
-- trigger were dropped.
--
-- `replica_ceiling` and `environments_withheld` are deliberately NOT granted.
-- They are designed narrowing terms, but nothing operates them yet, and an
-- ungranted column cannot be misused while it waits. They are opened in a later
-- migration, together with the code that drives them and its adversarial tests.
GRANT SELECT ON sre_agent_operational_state TO sre_management, sre_activation, sre_attest_runtime, sre_attest_identity, sre_attest_tool_access;
GRANT UPDATE (suspended, suspended_reason, suspended_by, suspended_at)
  ON sre_agent_operational_state TO sre_management;

-- Activation: creates the row that IS the reviewed activation, and removes one
-- for an Agent Git no longer approves. It holds no UPDATE at all — it may bring
-- an Agent into existence here or take it out, never operate it.
GRANT INSERT, DELETE ON sre_agent_operational_state TO sre_activation;

-- Attestation: observations only, on roles DISTINCT from activation (so one
-- stolen credential cannot both activate an Agent and vouch for it) and
-- distinct from EACH OTHER (so one cannot manufacture all three proofs).
-- Row-level security above confines each to its own `kind`.
GRANT SELECT ON sre_agent_attestation TO sre_management, sre_activation;
GRANT SELECT, INSERT, UPDATE, DELETE ON sre_agent_attestation
  TO sre_attest_runtime, sre_attest_identity, sre_attest_tool_access;

-- Audit is readable by all three and writable by NONE of them: the SECURITY
-- DEFINER trigger writes it, so a role cannot forge or suppress its own record.
-- Only the exporter marks rows drained.
GRANT SELECT ON sre_agent_state_audit TO sre_management, sre_activation;
GRANT UPDATE (exported_at) ON sre_agent_state_audit TO sre_activation;

-- only the attester draws generations; management must not be able to burn
-- them, and activation has no attestation to stamp
REVOKE ALL ON SEQUENCE sre_envelope_generation_seq FROM PUBLIC, sre_management, sre_activation, sre_attest_runtime, sre_attest_identity, sre_attest_tool_access;
GRANT USAGE ON SEQUENCE sre_envelope_generation_seq TO sre_attest_runtime, sre_attest_identity, sre_attest_tool_access;
