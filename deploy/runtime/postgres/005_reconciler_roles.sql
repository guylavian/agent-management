-- LOGIN USERS for the operational control plane roles.
--
-- The roles themselves are defined in 002_agent_operational_state.sql and hold
-- no login ability (NOLOGIN). This migration creates the login users and grants
-- the appropriate roles to them, so the reconciler and attesters can authenticate
-- and assume their respective roles.
--
-- Passwords are set out of band by the deployment operator and stored in a
-- Secret with the connection URLs. See deploy/on-prem/secrets.example.yaml.

-- ---------------------------------------------------------------------------
-- SRE_ACTIVATION role: reconciler writes to sre_agent_operational_state
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sre_activation_user') THEN
    CREATE ROLE sre_activation_user WITH LOGIN PASSWORD '<set via Secret deployment>'
      VALID UNTIL 'infinity'
      CONNECTION LIMIT -1;
  END IF;
END $$;

-- Grant the sre_activation role to the login user
GRANT sre_activation TO sre_activation_user;

-- ---------------------------------------------------------------------------
-- SRE_ATTEST_RUNTIME role: runtime attestation writer
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sre_attest_runtime_user') THEN
    CREATE ROLE sre_attest_runtime_user WITH LOGIN PASSWORD '<set via Secret deployment>'
      VALID UNTIL 'infinity'
      CONNECTION LIMIT -1;
  END IF;
END $$;

GRANT sre_attest_runtime TO sre_attest_runtime_user;

-- ---------------------------------------------------------------------------
-- SRE_ATTEST_IDENTITY role: identity attestation writer
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sre_attest_identity_user') THEN
    CREATE ROLE sre_attest_identity_user WITH LOGIN PASSWORD '<set via Secret deployment>'
      VALID UNTIL 'infinity'
      CONNECTION LIMIT -1;
  END IF;
END $$;

GRANT sre_attest_identity TO sre_attest_identity_user;

-- ---------------------------------------------------------------------------
-- SRE_ATTEST_TOOL_ACCESS role: tool access attestation writer
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sre_attest_tool_access_user') THEN
    CREATE ROLE sre_attest_tool_access_user WITH LOGIN PASSWORD '<set via Secret deployment>'
      VALID UNTIL 'infinity'
      CONNECTION LIMIT -1;
  END IF;
END $$;

GRANT sre_attest_tool_access TO sre_attest_tool_access_user;
