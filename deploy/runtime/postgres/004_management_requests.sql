-- MANAGEMENT REQUESTS: what was ASKED for.
--
--   Run     = execution of a user question
--   Request = execution of a management change
--
-- This table holds the request's own data — who asked, for what, which branch,
-- which pull request. What was OBSERVED about it afterwards lives in
-- sre_execution_event, which is generic and knows nothing about Agents.
--
-- The split is deliberate. A request record is a small, mutable set of facts
-- this plane owns (a pull request number arrives after the row is created). An
-- event is an immutable observation that any plane may append. Collapsing them
-- would either make the record append-only, which it cannot be, or make the
-- log rewritable, which would stop it being a log.
--
-- NO STATUS COLUMN, deliberately. Whether the Agent this request changed is
-- currently routable is answered by sre_agent_operational_state and
-- sre_agent_attestation, live, on every read. A stored status would be a
-- fourth source of truth and would go stale the first time a suspension landed
-- between two page loads.

CREATE TABLE IF NOT EXISTS sre_management_request (
  -- COMPOSITE with the environment, matching the event stream's own
  -- environment-qualified id. A single-column key let a second estate's insert
  -- of the same request id be silently ignored, leaving its event stream
  -- orphaned with no row to explain it.
  request_id    text        NOT NULL,
  agent_id      text        NOT NULL,
  environment   text        NOT NULL,
  type          text        NOT NULL,
  requested_by  text        NOT NULL,
  created_at    timestamptz NOT NULL,
  branch        text        NOT NULL,
  effects       jsonb       NOT NULL DEFAULT '[]',
  -- the rendered configuration diff: YAML the reviewer will read, never a
  -- credential. `validate:tracked` and the runtime's own redaction keep it that
  -- way upstream of here.
  diff          jsonb,
  prepared_at   timestamptz,
  prepare_error text,
  published_at  timestamptz,
  publish_error text,
  not_configured text,
  pull_request_number  integer,
  pull_request_url     text,
  -- the provider's last answer, cached so a terminal state stops being polled
  pull_request_state   text,
  pull_request_state_at timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT NOW(),

  PRIMARY KEY (request_id, environment)
);

CREATE INDEX IF NOT EXISTS sre_management_request_recent_idx
  ON sre_management_request (created_at DESC);

-- an operator looking at one Agent wants that Agent's requests
CREATE INDEX IF NOT EXISTS sre_management_request_agent_idx
  ON sre_management_request (agent_id, environment, created_at DESC);

CREATE OR REPLACE FUNCTION sre_management_request_touch() RETURNS trigger
  SET search_path = pg_catalog, public
AS $$
BEGIN
  /*
   * IDENTITY IS IMMUTABLE. The request id is the correlation key every event
   * joins on, and the agent and environment are what the request is ABOUT.
   * Letting any of them move would reattribute a change — and its whole
   * timeline — to a different Agent or a different estate, while the event
   * stream carried on pointing at the original.
   */
  IF NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'request_id, agent_id, environment and created_at are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sre_management_request_updated ON sre_management_request;
CREATE TRIGGER sre_management_request_updated
  BEFORE UPDATE ON sre_management_request
  FOR EACH ROW EXECUTE FUNCTION sre_management_request_touch();

-- ---------------------------------------------------------------------------
-- The management plane writes its own requests, and nothing else.
--
-- It holds no privilege here that could affect routing: this table is read by
-- the console and joined to nothing that decides authority.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sre_requests_writer') THEN
    CREATE ROLE sre_requests_writer NOLOGIN;
  END IF;
END $$;

REVOKE ALL ON sre_management_request FROM PUBLIC, sre_requests_writer;
-- column-level UPDATE: the identity columns are not writable even if the
-- trigger above were dropped, and a row cannot be reattributed to another Agent
-- or another environment after it is created
GRANT SELECT, INSERT ON sre_management_request TO sre_requests_writer;
GRANT UPDATE (branch, effects, diff, prepared_at, prepare_error, published_at,
              publish_error, not_configured, pull_request_number, pull_request_url,
              pull_request_state, pull_request_state_at)
  ON sre_management_request TO sre_requests_writer;
