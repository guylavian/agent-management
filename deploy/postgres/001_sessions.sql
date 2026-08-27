CREATE TABLE IF NOT EXISTS sre_sessions (
  subject text NOT NULL,
  session_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  context jsonb NOT NULL,
  PRIMARY KEY (subject, session_id)
);

CREATE INDEX IF NOT EXISTS sre_sessions_expiry_idx ON sre_sessions (expires_at);
