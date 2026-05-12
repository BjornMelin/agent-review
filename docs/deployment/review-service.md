# Review Service Deployment

`apps/review-service` is the hosted API, durable run-state owner, GitHub
publication coordinator, and Workflow/Sandbox orchestration boundary. Deploy it
as a server runtime with durable storage before exposing Review Room or hosted
CLI clients to private repositories.

## Runtime Shape

- `src/server.ts` constructs providers, auth, GitHub publication, optional
  Convex mirroring, storage, and `ReviewWorker`.
- `src/app.ts` owns the `/v1/review/*` route contract and is import-safe for
  tests.
- Postgres/Drizzle stores runs, lifecycle events, artifacts, run metrics,
  status transitions, auth audit rows, publication records, and finding triage.
- Vercel Workflow coordinates detached execution; it is not the queryable run
  store.
- Vercel Sandbox executes only detached `remoteSandbox` custom-target reviews
  under policy/audit controls.

## Required Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | Optional | Bind port; defaults to `3042`. |
| `DATABASE_URL` / `POSTGRES_URL` | Required for durable hosted deployments | PostgreSQL-compatible connection string for Drizzle storage. |
| `REVIEW_SERVICE_AUTH_MODE=required` | Required for hosted deployments | Enables scoped service-token and GitHub-backed authorization. Production rejects `disabled`. |
| `REVIEW_SERVICE_TOKEN_PEPPER` | Required when auth is enabled | HMAC pepper for scoped service-token verifier hashes. |
| `REVIEW_SERVICE_ALLOWED_CWD_ROOTS` | Recommended | Comma-separated roots allowed for request `cwd` values. |
| `REVIEW_SERVICE_HOSTED_REPOSITORY_ROOTS` | Recommended | Comma-separated checkout parent roots; defaults to allowed cwd roots. Authenticated starts must run under `<root>/<owner>/<repo>`. |
| `GITHUB_APP_ID` | Required for publish | GitHub App ID used to mint installation-scoped tokens. |
| `GITHUB_APP_PRIVATE_KEY` | Required for publish | GitHub App private key. Escaped `\n` sequences are normalized at startup. |
| `GITHUB_API_BASE_URL` | Optional | GitHub Enterprise Server API base URL override. |
| `AI_GATEWAY_API_KEY` | Required for `gateway:*` models | AI Gateway provider credential. |
| `OPENROUTER_API_KEY` | Required for `openrouter:*` models | OpenRouter provider credential. |
| `CODEX_BIN` | Optional | Override Codex CLI executable path for `codexDelegate`. |
| `CONVEX_URL` | Optional | Enables non-blocking Convex metadata mirror writes. |

## Startup

1. Install workspace dependencies and build artifacts:

   ```bash
   pnpm install --frozen-lockfile
   pnpm build
   ```

2. Apply database migrations before starting the service:

   ```bash
   pnpm --filter @review-agent/review-service db:migrate
   ```

3. Start with auth required:

   ```bash
   REVIEW_SERVICE_AUTH_MODE=required \
   REVIEW_SERVICE_TOKEN_PEPPER=<pepper> \
   DATABASE_URL=<postgres-url> \
   node apps/review-service/dist/server.js
   ```

4. Confirm provider readiness from a trusted host:

   ```bash
   REVIEW_AGENT_SERVICE_URL=https://<service-origin> \
   REVIEW_AGENT_SERVICE_TOKEN=rat_<tokenId>_<secret> \
   pnpm --filter @review-agent/review-cli dev doctor --provider all --json
   ```

## GitHub App Permissions

The service mints installation tokens with the narrow permissions required by
the requested operation:

| Operation | Permissions |
| --- | --- |
| Publish preview | `pull_requests: read` |
| Publish Checks, SARIF, and PR comments | `checks: write`, `pull_requests: write`, `security_events: write` |

GitHub documents Check Runs under the Checks REST API and SARIF upload under
the Code Scanning REST API. The service binds outbound publication to the stored
repository authorization snapshot and commit SHA; a completed custom prompt run
without commit metadata is watchable but not publishable.

## Runtime Limits and Backpressure

Default app-factory limits are:

| Limit | Default |
| --- | --- |
| Request body bytes | `262144` |
| Queued runs | `100` |
| Running runs | `10` |
| Active runs per runtime scope | `2` |
| Runtime lease TTL | `600000` ms |
| Event stream poll interval | `15000` ms |

The current service enforces request-size limits, request schema/security
budgets, queue/running/per-scope backpressure, and provider/model budgets.
Endpoint rate limiting for repeated status, SSE, artifact, and cancel reads is
a deployment-edge responsibility until app-level rate-limit middleware is
introduced. Configure it in the hosting layer or API gateway and keep the
limits aligned with the threat model.

## Health and Smoke Checks

The service currently has no public unauthenticated health endpoint. Use an
authenticated read-only CLI smoke after deployment:

```bash
review-agent list --limit 1 --repo owner/name --service-url "$REVIEW_AGENT_SERVICE_URL"
```

For end-to-end hosted verification, run one commit-backed detached review,
watch it to terminal state, fetch an artifact, preview publication, and publish
only when the target repository is disposable or explicitly approved.

## Rollback

1. Prefer rolling back the service deployment before rolling back migrations.
2. If a schema migration caused the incident, stop writes first, snapshot the
   database, then ship a forward migration that restores route compatibility.
3. If provider keys or GitHub App credentials are compromised, rotate secrets
   and revoke affected service tokens before resuming hosted starts.
4. If Workflow or Sandbox is degraded, continue local-trusted CLI usage and
   reject or pause detached hosted starts until Workflow reconciliation is
   healthy.

## References

- Service API spec: [../architecture/spec/review-service-api.md](../architecture/spec/review-service-api.md)
- System overview: [../architecture/spec/system-overview.md](../architecture/spec/system-overview.md)
- Threat model: [../architecture/security/threat-model.md](../architecture/security/threat-model.md)
- Operator runbooks: [../operations/operator-runbooks.md](../operations/operator-runbooks.md)
