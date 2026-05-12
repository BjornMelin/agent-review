CREATE TYPE review_finding_triage_status AS ENUM (
  'open',
  'accepted',
  'false-positive',
  'fixed',
  'published',
  'dismissed',
  'ignored'
);

CREATE TABLE IF NOT EXISTS review_finding_triage (
  review_id text NOT NULL REFERENCES review_runs(review_id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  status review_finding_triage_status NOT NULL,
  note text,
  actor text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT review_finding_triage_review_fingerprint_pk PRIMARY KEY (review_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS review_finding_triage_review_status_idx
  ON review_finding_triage (review_id, status);

CREATE TABLE IF NOT EXISTS review_finding_triage_audit (
  audit_id text PRIMARY KEY,
  review_id text NOT NULL REFERENCES review_runs(review_id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  from_status review_finding_triage_status,
  to_status review_finding_triage_status NOT NULL,
  note text,
  actor text,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS review_finding_triage_audit_review_created_at_idx
  ON review_finding_triage_audit (review_id, created_at);
CREATE INDEX IF NOT EXISTS review_finding_triage_audit_fingerprint_idx
  ON review_finding_triage_audit (review_id, fingerprint);
