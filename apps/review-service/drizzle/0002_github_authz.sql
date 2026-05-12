ALTER TABLE review_runs
  ADD COLUMN IF NOT EXISTS "authorization" jsonb,
  ADD COLUMN IF NOT EXISTS auth_actor_type text,
  ADD COLUMN IF NOT EXISTS auth_actor_id text,
  ADD COLUMN IF NOT EXISTS github_installation_id text,
  ADD COLUMN IF NOT EXISTS github_repository_id text,
  ADD COLUMN IF NOT EXISTS github_owner text,
  ADD COLUMN IF NOT EXISTS github_repo text,
  ADD COLUMN IF NOT EXISTS request_hash text;

CREATE INDEX IF NOT EXISTS review_runs_github_repo_idx
  ON review_runs (github_installation_id, github_repository_id);
CREATE INDEX IF NOT EXISTS review_runs_auth_actor_idx
  ON review_runs (auth_actor_type, auth_actor_id);
CREATE INDEX IF NOT EXISTS review_runs_request_hash_idx
  ON review_runs (request_hash);

CREATE TABLE IF NOT EXISTS github_users (
  github_user_id text PRIMARY KEY,
  login text NOT NULL,
  name text,
  avatar_url text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS github_installations (
  installation_id text PRIMARY KEY,
  account_login text NOT NULL,
  account_type text NOT NULL,
  permissions jsonb NOT NULL,
  repository_selection text NOT NULL,
  suspended_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS github_repositories (
  repository_id text PRIMARY KEY,
  installation_id text NOT NULL REFERENCES github_installations(installation_id) ON DELETE CASCADE,
  owner text NOT NULL,
  name text NOT NULL,
  full_name text NOT NULL,
  visibility text NOT NULL,
  permissions jsonb NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS github_repositories_owner_name_idx
  ON github_repositories (owner, name);
CREATE INDEX IF NOT EXISTS github_repositories_installation_idx
  ON github_repositories (installation_id);

CREATE TABLE IF NOT EXISTS github_repository_permissions (
  github_user_id text NOT NULL REFERENCES github_users(github_user_id) ON DELETE CASCADE,
  repository_id text NOT NULL REFERENCES github_repositories(repository_id) ON DELETE CASCADE,
  permission text NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT github_repository_permissions_user_repo_pk PRIMARY KEY (github_user_id, repository_id)
);

CREATE TABLE IF NOT EXISTS service_tokens (
  token_id text PRIMARY KEY,
  token_prefix text NOT NULL,
  token_hash text NOT NULL,
  name text NOT NULL,
  scopes jsonb NOT NULL,
  repository jsonb NOT NULL,
  created_by jsonb,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS service_tokens_prefix_idx
  ON service_tokens (token_prefix);
CREATE INDEX IF NOT EXISTS service_tokens_revoked_at_idx
  ON service_tokens (revoked_at);

CREATE TABLE IF NOT EXISTS auth_audit_events (
  audit_event_id text PRIMARY KEY,
  event_type text NOT NULL,
  operation text NOT NULL,
  result text NOT NULL,
  reason text NOT NULL,
  status integer NOT NULL,
  principal jsonb,
  token_id text,
  token_prefix text,
  repository jsonb,
  review_id text,
  request_id text,
  metadata jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_audit_events_created_at_idx
  ON auth_audit_events (created_at);
CREATE INDEX IF NOT EXISTS auth_audit_events_review_id_idx
  ON auth_audit_events (review_id);
CREATE INDEX IF NOT EXISTS auth_audit_events_token_id_idx
  ON auth_audit_events (token_id);
