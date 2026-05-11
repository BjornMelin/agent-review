ALTER TABLE review_runs
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_scope_key text,
  ADD COLUMN IF NOT EXISTS lease_acquired_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;

CREATE INDEX IF NOT EXISTS review_runs_lease_expires_at_idx
  ON review_runs (lease_expires_at);
CREATE INDEX IF NOT EXISTS review_runs_lease_scope_key_idx
  ON review_runs (lease_scope_key);
