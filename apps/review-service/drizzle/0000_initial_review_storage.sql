CREATE TABLE IF NOT EXISTS review_runs (
  review_id text PRIMARY KEY,
  run_id text NOT NULL,
  status text NOT NULL,
  request jsonb NOT NULL,
  request_summary jsonb NOT NULL,
  result jsonb,
  error text,
  detached_run_id text,
  workflow_run_id text,
  sandbox_id text,
  event_sequence integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  retention_expires_at timestamptz,
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS review_runs_status_idx
  ON review_runs (status);
CREATE INDEX IF NOT EXISTS review_runs_updated_at_idx
  ON review_runs (updated_at);
CREATE INDEX IF NOT EXISTS review_runs_retention_expires_at_idx
  ON review_runs (retention_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS review_runs_detached_run_id_idx
  ON review_runs (detached_run_id)
  WHERE detached_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS review_events (
  review_id text NOT NULL REFERENCES review_runs(review_id) ON DELETE CASCADE,
  event_id text NOT NULL,
  sequence integer NOT NULL,
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT review_events_review_id_sequence_pk PRIMARY KEY (review_id, sequence)
);

CREATE UNIQUE INDEX IF NOT EXISTS review_events_event_id_idx
  ON review_events (event_id);
CREATE INDEX IF NOT EXISTS review_events_review_id_created_at_idx
  ON review_events (review_id, created_at);

CREATE TABLE IF NOT EXISTS review_artifacts (
  artifact_id text PRIMARY KEY,
  review_id text NOT NULL REFERENCES review_runs(review_id) ON DELETE CASCADE,
  format text NOT NULL,
  content_type text NOT NULL,
  byte_length integer NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS review_artifacts_review_id_format_idx
  ON review_artifacts (review_id, format);
CREATE UNIQUE INDEX IF NOT EXISTS review_artifacts_storage_key_idx
  ON review_artifacts (storage_key);

CREATE TABLE IF NOT EXISTS review_status_transitions (
  transition_id text PRIMARY KEY,
  review_id text NOT NULL REFERENCES review_runs(review_id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS review_status_transitions_review_id_created_at_idx
  ON review_status_transitions (review_id, created_at);
