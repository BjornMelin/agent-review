CREATE TYPE review_publication_channel AS ENUM (
  'checkRun',
  'sarif',
  'pullRequestComment'
);

CREATE TYPE review_publication_status AS ENUM (
  'published',
  'skipped',
  'unsupported',
  'failed'
);

CREATE TABLE IF NOT EXISTS review_publications (
  publication_id text PRIMARY KEY,
  review_id text NOT NULL REFERENCES review_runs(review_id) ON DELETE CASCADE,
  channel review_publication_channel NOT NULL,
  target_key text NOT NULL,
  status review_publication_status NOT NULL,
  external_id text,
  external_url text,
  marker text,
  message text,
  error text,
  metadata jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS review_publications_review_channel_target_idx
  ON review_publications (review_id, channel, target_key);
CREATE INDEX IF NOT EXISTS review_publications_review_id_idx
  ON review_publications (review_id);
