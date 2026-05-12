# Review Service API

Service package: `@review-agent/review-service`  
Default bind: `PORT=3042`

Base path: `/v1/review`

## Runtime Construction

`apps/review-service/src/app.ts` exports `createReviewServiceApp(deps)`.
The app factory owns all route registration and accepts injected providers,
worker client, optional bridge, store adapter, clock/UUID functions, logger,
auth policy, config, and inline runner. The package entrypoint `src/index.ts`
re-exports the factory, while `src/server.ts` constructs production
dependencies and calls `serve()`. Production startup is fail-closed for auth:
`src/server.ts` defaults `REVIEW_SERVICE_AUTH_MODE` to `required`, requires a
configured auth store and `REVIEW_SERVICE_TOKEN_PEPPER`, and rejects
`REVIEW_SERVICE_AUTH_MODE=disabled` in production. Non-production local
development can opt into disabled auth explicitly.

The service store uses the async `ReviewStoreAdapter` boundary exported from
`apps/review-service/src/storage/index.ts`. Production startup selects a
Drizzle/node-postgres store when `DATABASE_URL` or `POSTGRES_URL` is configured.
No-database local development falls back to `createInMemoryReviewStore()` with
the same async contract. `NODE_ENV=production` requires `DATABASE_URL` or
`POSTGRES_URL` unless volatile memory is selected explicitly with
`REVIEW_SERVICE_STORAGE=memory`.

GitHub publication state uses the same storage environment through
`ReviewPublicationStoreAdapter`. Publication records are durable per review,
channel, and target key so retrying a publish request updates existing GitHub
side effects instead of creating duplicate checks or comments.

Drizzle schema and migration ownership lives in `apps/review-service`:

- `src/storage/schema.ts`
- `drizzle/0000_initial_review_storage.sql`
- `drizzle/0001_review_runtime_control.sql`
- `drizzle/0002_github_authz.sql`
- `drizzle/0003_github_publications.sql`
- `drizzle.config.ts`

Run migrations from the service package with:

```bash
pnpm --filter @review-agent/review-service db:migrate
```

## Status Model

Defined by `ReviewRunStatusSchema` in `@review-agent/review-types`.

- `queued`
- `running`
- `completed`
- `failed`
- `cancelled`

## Authentication and Repository Authorization

Hosted service routes use bearer authentication before any `/v1/*` route work
begins. Missing or invalid bearer tokens return `401` with
`WWW-Authenticate: Bearer`. A token that is valid but lacks the required
operation scope returns `403`. Unknown review IDs and review IDs owned by a
different repository return `404` so run identifiers are not an authorization
boundary.

Supported auth sources:

- Scoped service tokens for CI and automation. Tokens use the
  `rat_<tokenId>_<secret>` shape; only an HMAC-SHA256 verifier hash is stored,
  keyed by token ID and protected by `REVIEW_SERVICE_TOKEN_PEPPER`.
- GitHub user access tokens verified through GitHub App installation
  repositories. The service revalidates the GitHub user and repository
  permission state before binding a run to a repository.

Every authenticated run persists an authorization snapshot on `review_runs`:
principal, GitHub installation, repository ID, owner/name, visibility,
effective scopes, actor, and request hash. Status, events, artifacts, and
cancel all authorize against the stored snapshot before syncing Workflow state,
attaching SSE listeners, returning artifacts, or mutating cancellation state.

Authn/authz decisions are written to `auth_audit_events` with safe metadata only:
principal, token ID/prefix, repository, operation, result, reason, status,
review ID, and request hash. Raw bearer tokens are never stored.

GitHub integration follows GitHub App and OAuth guidance:

- https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-github-apps
- https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps

## `POST /v1/review/start`

Starts a review.

### Request Body

```json
{
  "request": {
    "cwd": "/absolute/path",
    "target": { "type": "uncommittedChanges" },
    "provider": "codexDelegate",
    "executionMode": "localTrusted",
    "outputFormats": ["json", "markdown"]
  },
  "repository": {
    "provider": "github",
    "owner": "octo-org",
    "name": "agent-review",
    "installationId": 123456,
    "repositoryId": 987654
  },
  "delivery": "inline"
}
```

- `request`: required `ReviewRequest`
- `repository`: required when hosted auth is enabled unless the authenticated
  token is bound to exactly one repository
- `delivery`: optional `inline|detached` (default `inline`)

Detached mode is active when `delivery=detached` or `request.detached=true`.
The request body is parsed by `ReviewStartRequestSchema`.

### Request Hardening

The service rejects start bodies over `maxRequestBodyBytes` before JSON parsing
and returns a generic validation error for malformed payloads. Parsed requests
are normalized with review security defaults from `review-types`:

- `maxFiles` defaults to `200` and cannot exceed `1000`.
- `maxDiffBytes` defaults to `1048576` and cannot exceed `4194304`.
- custom instructions, model IDs, refs, path filters, and output format lists
  are bounded by the shared schema.
- branch refs reject revision expressions and Git pathspec/control syntax;
  commit targets must be object IDs and are verified as commits by the git
  collector.
- include/exclude path filters must be repository-relative and cannot use
  absolute paths, `..` segments, negation syntax, or Git pathspec magic.
- service-level `reviewLimits` may be stricter than the shared schema defaults;
  explicit client `maxFiles` and `maxDiffBytes` values are clamped to those
  configured service ceilings, and all other bounded request fields are checked
  against the stricter resolved service limits before the runner, worker, or git
  collector sees the request. Configured limits cannot widen the compiled
  shared defaults.

Hosted service construction must set `allowedCwdRoots`; `src/server.ts`
defaults this to the service process cwd and accepts a comma-separated override
through `REVIEW_SERVICE_ALLOWED_CWD_ROOTS`. Requests outside configured roots
are rejected before runtime reservation or worker dispatch.

When hosted auth is enabled, start requests must also resolve under an
authorized repository checkout. `hostedRepositoryRoots` is configured with
`REVIEW_SERVICE_HOSTED_REPOSITORY_ROOTS` and defaults to `allowedCwdRoots`; the
effective `cwd` must be below `<hostedRepositoryRoot>/<owner>/<repo>` for the
repository granted by the bearer token. A valid token for one repository cannot
start a run from another checkout path.

### Responses

- `200`: inline run finished; response includes `result` summary payload
- `202`: detached accepted; response includes `detachedRunId`
- `400`: request parse/validation error
- `401`: missing or invalid bearer token
- `403`: authenticated token lacks the requested repository or operation scope
- `413`: request body exceeds the configured byte limit
- `429`: runtime queue, global concurrency, or per-scope active-run limit reached
- `502`: worker or storage startup error

### Runtime Capacity

The service atomically reserves runtime capacity before dispatching inline or
detached work. Tunables live in `ReviewServiceConfig`:

- `maxQueuedRuns`: positive integer, default `100`. Caps queued nonterminal
  records.
- `maxRunningRuns`: positive integer, default `10`. Caps running nonterminal
  records and queued detached Workflow records that have already been accepted
  by the worker.
- `maxActiveRunsPerScope`: positive integer, default `2`. Caps running records
  and leased queued dispatch records sharing the same runtime scope key.
- `runtimeLeaseTtlMs`: positive integer milliseconds, default `600000`. Sets
  the heartbeat lease window for accepted work.
- `maxRecordAgeMs`: positive integer milliseconds, default `3600000`. Sets
  terminal retention and the upgrade-drain window for considering legacy
  unleased queued or running records valid during scoped-limit reconstruction
  and queue/drain accounting.

Every accepted run receives a service-owned lease with `owner`, `scopeKey`,
`acquiredAt`, `heartbeatAt`, and `expiresAt`. `maxQueuedRuns` bounds queued
records. `maxRunningRuns` bounds records actively consuming execution capacity:
running inline runs, running detached runs, and queued detached Workflow records
after a `detachedRunId` has been persisted. The current scope key is derived
from execution mode, provider, canonicalized cwd, and target identity.
Leased queued rows count against scoped capacity immediately so concurrent
same-scope detached dispatches cannot over-admit while `startDetached` is still
pending. Nonterminal leased rows keep counting against capacity even after their
lease expiry timestamp until service reconciliation reaches a terminal status.
Legacy unleased queued or running rows also count against the global
queue/running limits during the `maxRecordAgeMs` upgrade-drain window; their
scoped limit is reconstructed from the persisted request when the service
supplies a scope-key derivation callback. Expired leased rows are marked
`failed` with `runtime lease expired` when the run is next reconciled.
Nonterminal detached Workflow status refreshes only unexpired leases, while
terminal Workflow status is still reconciled after lease expiry. Workflow
remains the execution orchestrator; `ReviewStoreAdapter` remains the queryable
lease/status source of truth.

### Redaction and Safe Errors

Service-owned logs, stored terminal errors, lifecycle events, status responses,
provider/core outputs, sandbox outputs, and generated artifacts use the shared
redaction helper from `review-types`. Public error responses are stable generic
messages except for known safe runtime policy errors such as queue pressure and
cwd allowlist rejection. Durable records store redacted request and completed
run payloads; the raw accepted request is kept in memory only long enough to
dispatch the runner or detached worker.

## `GET /v1/review/:reviewId`

Returns review status and result summary when available.

### Response Fields

- `reviewId`
- `status`
- `error` (optional)
- `result` (optional review result payload)
- `createdAt`
- `updatedAt`
- `publications` (optional, durable GitHub publication records)

Returns `404` when review ID is unknown.
When auth is enabled, `404` is also returned for review IDs owned by a
repository outside the authenticated principal's access boundary.
The response body follows `ReviewStatusResponseSchema`.

## `POST /v1/review/:reviewId/publish`

Publishes a completed hosted review to GitHub. The route requires
`review:publish` and authorizes against the stored run ownership snapshot before
any GitHub write. GitHub-user bearer tokens are dynamically revalidated on every
publish request, while service tokens must already carry the `review:publish`
scope.

Publication writes three GitHub surfaces when the target supports them:

- Check Run summary on the reviewed commit.
- SARIF code-scanning upload for machine-readable findings.
- Inline pull request comments for findings whose locations map to changed
  lines.

The production server enables this endpoint when `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY` are configured. Installation tokens are minted for the
stored repository ID only and request the minimal GitHub App permissions needed
for publication: Checks write, Pull requests write, and Code scanning alerts
write. `GITHUB_API_BASE_URL` is honored for GitHub Enterprise Server testing.

### Publication Safety

- Reviews must be terminal `completed` and have a persisted result.
- The stored repository ID, PR number, and reviewed commit SHA are compared with
  the current GitHub PR before publishing.
- A changed PR head SHA returns `409` so stale review output is not published to
  a newer commit.
- Check Runs, SARIF uploads, and PR comments persist channel-specific target
  keys in `review_publications`.
- PR comments include hidden idempotency markers and are updated in place;
  obsolete comments owned by the same marker family are deleted.
- Markdown bodies are redacted, mention-neutralized, HTML-comment escaped, and
  truncated to GitHub-safe limits before outbound writes.
- SARIF locations are repository-relative; host absolute paths are not
  published.

### Response

`200` returns `ReviewPublishResponse`:

```json
{
  "reviewId": "review_123",
  "status": "published",
  "publications": [
    {
      "publicationId": "review_123:checkRun:abcdef",
      "reviewId": "review_123",
      "channel": "checkRun",
      "targetKey": "check-run:abcdef",
      "status": "published",
      "externalId": "123456",
      "externalUrl": "https://github.com/octo-org/agent-review/actions/runs/...",
      "createdAt": 1778560000000,
      "updatedAt": 1778560000000
    }
  ]
}
```

Responses:

- `200`: publish attempt completed; inspect per-channel publication statuses.
- `401`: missing or invalid bearer token.
- `403`: authenticated token lacks `review:publish` or current GitHub write
  authorization.
- `404`: review not found or outside the authenticated repository boundary.
- `409`: review is not completed, has no publishable result, has no GitHub
  publish target, or the PR head no longer matches the reviewed commit.
- `502`: publication service is not configured or GitHub/storage publication
  failed.

Relevant GitHub API references:

- https://docs.github.com/en/rest/checks/runs
- https://docs.github.com/en/rest/code-scanning/code-scanning#upload-an-analysis-as-sarif-data
- https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support-for-code-scanning
- https://docs.github.com/en/rest/pulls/comments

## `GET /v1/review/:reviewId/events`

Server-Sent Events stream of lifecycle events.

### Behavior

- Attaches the live process-local listener before replay so events emitted
  during stream setup are not missed.
- Replays historical events selected by the cursor.
- Supports cursor replay with `afterEventId` query parameter or `Last-Event-ID`
  header, plus optional bounded `limit` query parameter.
- Streams live events while connection remains open.
- Sends a `keepalive` SSE event with empty data every 15 seconds.
- Event payload shape follows `LifecycleEvent`, including `meta.correlation.reviewId` and event IDs/timestamps.

Returns `404` when review ID is unknown.

## `POST /v1/review/:reviewId/cancel`

Attempts cancellation of a detached run.

Cancellation is not reported as successful unless the worker/runtime accepts the
cancel request and later reports a cancelled terminal state. The service
persists `cancelRequestedAt`, delegates cancellation to Workflow, and keeps the
runtime lease while cancellation is pending. The worker also aborts the active
in-process Workflow step when that step is running in the same worker process;
the Workflow cancellation record remains the durable cross-process authority.
The service only transitions the durable record to `cancelled` after Workflow
reports `cancelled`. Unknown review IDs return `404`. Terminal, inline-only,
duplicate, or lease-expired requests return `409` with `cancelled: false`.

### Responses

- `200`: cancellation accepted by runtime and durable status becomes `cancelled`
- `202`: cancellation accepted by runtime but terminal cancelled status has not
  been observed yet
- `404`: review not found
- `409`: cancellation not possible (e.g., no detached run or terminal state reached)
- `502`: service storage or Workflow runtime cancellation failed

## `GET /v1/review/:reviewId/artifacts/:format`

Fetches generated artifact string for a completed review run.

### Supported `:format`

- `sarif`
- `json`
- `markdown`

### Content Types

- `markdown`: `text/markdown; charset=utf-8`
- `sarif`/`json`: `application/json; charset=utf-8`

Returns:

- `404` when review/result/artifact is unavailable.
- `400` when `:format` does not parse through `OutputFormatSchema`.

## Notes and Constraints

- Service state is durable when `DATABASE_URL` or `POSTGRES_URL` is configured.
- Service state defaults to in-memory storage only for local no-database
  development. Production startup fails without a database URL unless
  `REVIEW_SERVICE_STORAGE=memory` is set.
- Detached Workflow run identifiers and observed states are persisted in the
  service store. Workflow orchestrates execution and retries, while
  `ReviewStoreAdapter` remains the queryable run/event/artifact state boundary.
- Provider and sandbox cancellation uses native `AbortSignal` support:
  AI SDK `generateText` receives `abortSignal`, the Codex delegate forwards the
  signal into the Rust process-group runner, and Vercel Sandbox command
  execution receives a linked signal.
- Authentication defaults to fail-closed in `createReviewServiceApp()` and
  `src/server.ts`; local allow-all requires explicit `authMode: "disabled"` or
  non-production `REVIEW_SERVICE_AUTH_MODE=disabled`.
- `remoteSandbox` execution mode must be requested with detached delivery. Inline
  `remoteSandbox` requests return `400` with
  `executionMode "remoteSandbox" requires detached delivery`.
- Git-backed `remoteSandbox` targets currently return `400` until sandbox source
  binding moves diff collection inside Vercel Sandbox. The accepted safe path is
  `target.type: "custom"`.
- Detached `remoteSandbox` runs are accepted by the service, executed by
  `review-worker`, and surface the sandbox ID in result metadata when available.
- Service error bodies follow `ReviewErrorResponseSchema`.
- Store and worker runtime failures return `502` JSON errors without exposing
  raw database or provider details.
