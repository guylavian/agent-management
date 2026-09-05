-- APPEND-ONLY EXECUTION EVENTS.
--
-- One fact that was observed about one stream, by one observer, at one moment.
-- A management Request is a stream; so is an Agent run; so, later, is an SSO
-- enrolment or a Kafka topic provisioning. Nothing in this schema knows what an
-- Agent is: `stream_kind` and `stream_id` are opaque, and `type` is free
-- vocabulary, so a second domain needs no migration.
--
-- EVENTS ARE NOT AUTHORITY. A row here says "this was observed". It never says
-- "this is permitted". Whether an Agent may route is answered by
-- sre_agent_operational_state and sre_agent_attestation, live, on every read —
-- see docs/architecture/hybrid-control-plane.md. A stale `ACTIVE_OBSERVED` must
-- never be able to speak for the present, which is why nothing joins this table
-- into a routing decision.

CREATE TABLE IF NOT EXISTS sre_execution_event (
  -- CALLER-SUPPLIED, because it is the idempotency key: a retry that reuses it
  -- is a no-op, and one that regenerates it would duplicate the timeline
  event_id     text        PRIMARY KEY,
  stream_kind  text        NOT NULL,
  stream_id    text        NOT NULL,
  -- when the fact was OBSERVED; `recorded_at` is when it reached this table,
  -- and the two differ whenever a writer retried or lagged
  occurred_at  timestamptz NOT NULL,
  source       text        NOT NULL,
  actor        text,
  type         text        NOT NULL,
  outcome      text        NOT NULL CHECK (outcome IN ('pending', 'ok', 'failed')),
  -- scalars only, enforced by the application before the insert: a nested
  -- object is where a token, a raw tool payload or model reasoning would hide
  metadata     jsonb       NOT NULL DEFAULT '{}',
  recorded_at  timestamptz NOT NULL DEFAULT NOW()
);

-- reading one stream's timeline, in order
CREATE INDEX IF NOT EXISTS sre_execution_event_stream_idx
  ON sre_execution_event (stream_kind, stream_id, occurred_at);

-- listing the streams that have moved most recently
CREATE INDEX IF NOT EXISTS sre_execution_event_recent_idx
  ON sre_execution_event (stream_kind, recorded_at DESC);

-- ---------------------------------------------------------------------------
-- Append-only, enforced rather than intended.
--
-- The writer role below holds no UPDATE and no DELETE, so ordinarily this
-- trigger never fires. It exists for the case where it otherwise would: a grant
-- made by hand during an incident, a future migration that widens privileges by
-- accident, a role that inherits more than anyone realised. A log that can be
-- rewritten is not a log, and "nobody was granted that" is a weaker guarantee
-- than "the table refuses".
--
-- Honest scope: this stops application roles. It does not stop the table owner,
-- the migration role or a DBA, who can drop the trigger — which is why the
-- durable audit ships off-box to OpenTelemetry and this table is the queryable
-- copy rather than the system of record.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sre_execution_event_is_append_only() RETURNS trigger
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'sre_execution_event is append-only; a correction is a new event, not a rewrite of an old one'
    USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sre_execution_event_immutable ON sre_execution_event;
CREATE TRIGGER sre_execution_event_immutable
  BEFORE UPDATE OR DELETE ON sre_execution_event
  FOR EACH ROW EXECUTE FUNCTION sre_execution_event_is_append_only();

-- ---------------------------------------------------------------------------
-- The writer identity.
--
-- Both planes append: the management API observes REQUEST_CREATED, PR_OPENED
-- and PR_MERGED; the reconciler observes ACTIVATION_OBSERVED and the three
-- attestation facts. Neither gains any authority by writing here, which is why
-- one role serves both — the events grant nothing, so splitting the credential
-- would protect nothing.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sre_events_writer') THEN
    CREATE ROLE sre_events_writer NOLOGIN;
  END IF;
END $$;

-- Re-running this migration must CONVERGE the boundary, not add to it: GRANT is
-- additive, so privilege drift would otherwise survive every future migration.
REVOKE ALL ON sre_execution_event FROM PUBLIC, sre_events_writer;

-- INSERT and SELECT only. No UPDATE, no DELETE: a correction is a new event, so
-- what was believed at the time survives — which is the entire reason to keep a
-- log rather than a status column.
GRANT SELECT, INSERT ON sre_execution_event TO sre_events_writer;
