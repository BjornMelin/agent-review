# Operator Runbooks

These runbooks cover the current hosted Review Agent Platform. They are
operator how-to guidance, not architecture explanation; the canonical contracts
remain in the specs and ADRs linked from [docs/README.md](../README.md).

## Auth and Service Tokens

### Provision

1. Configure `REVIEW_SERVICE_AUTH_MODE=required` for hosted service
   deployments. Production startup rejects disabled auth.
2. Set `REVIEW_SERVICE_TOKEN_PEPPER` before minting scoped service tokens.
3. Store only scoped `rat_<tokenId>_<secret>` tokens in CI or Review Room
   server-side environment variables.
4. Bind automation tokens to the smallest repository and scope set required:
   `review:start`, `review:read`, `review:cancel`, and `review:publish` only
   when the workflow needs those operations.
5. Current code exposes token generation and durable upsert primitives
   (`createServiceTokenCredential()` and `setServiceToken()`), but no committed
   admin CLI exists yet. Until that tooling ships, mint/revoke tokens through a
   reviewed operator script that imports those helpers, prints the raw token
   once, and stores only the verifier record.

### Diagnose

1. `401` with `WWW-Authenticate: Bearer` means the token is missing or invalid.
2. `403` means the principal exists but lacks the requested operation or
   repository scope.
3. `404` on a known review ID usually means the token is valid for a different
   repository; review IDs are not an authorization boundary.
4. Inspect safe auth audit rows and service logs for principal, token prefix,
   repository, operation, result, status, and request hash. Do not log raw
   bearer tokens.

### Rotate

1. Mint a replacement scoped token and deploy it to callers.
2. Revoke the old token ID in the auth store by setting `revokedAt` and
   `updatedAt` through the same reviewed operator path that manages token
   records.
3. Confirm existing SSE streams stop after revocation or secret rotation.
4. Run `review-agent doctor --provider all --json` and one read-only
   `review-agent list --repo owner/name` smoke with the new token.

## Storage and Migrations

### Provision

1. Provide `DATABASE_URL` or `POSTGRES_URL` for durable hosted service
   deployments.
2. Run migrations before service startup:

   ```bash
   pnpm --filter @review-agent/review-service db:migrate
   ```

3. Use `REVIEW_SERVICE_STORAGE=memory` only for explicit volatile local or
   emergency deployments. Do not treat memory storage as durable production
   state.

### Diagnose

1. If active-run list calls return `502`, inspect service logs for list
   freshness or Workflow reconciliation failures before trusting stale
   `queued` or `running` records.
2. Confirm `review_runs`, lifecycle events, artifacts, status transitions,
   publication records, finding triage records, and run metrics exist for the
   affected review.
3. If a migration fails, roll forward with a focused migration fix. Do not
   hand-edit production rows unless the incident owner approves a data repair.

## GitHub App and Publication

### Provision

1. Configure `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` on the review service.
2. Install the app on the repositories that will publish Checks, SARIF, and PR
   comments.
3. Ensure installation tokens have the minimum permissions needed for the
   publication channels in use:

   | Operation | Permissions |
   | --- | --- |
   | Publish preview | `pull_requests: read` |
   | Publish Checks, SARIF, and PR comments | `checks: write`, `pull_requests: write`, `security_events: write` |

4. Start publishable runs with commit-backed targets plus repository and PR
   context; custom prompt runs can be watched but cannot publish to GitHub.

### Diagnose

1. Use `GET /v1/review/:reviewId/publish/preview` or Review Room publish
   preview before mutating GitHub.
2. Publication requires a completed review, repository authorization, and a
   commit SHA target.
3. Durable publication records are keyed by review, channel, and target so
   retries update prior side effects instead of spamming duplicate Checks or
   comments.
4. A `partial` response means at least one channel failed. Inspect per-channel
   publication records before retrying.

## Provider Keys and Model Policy

### Provision

1. Use `AI_GATEWAY_API_KEY` for `gateway:*` model routes.
2. Use `OPENROUTER_API_KEY` for `openrouter:*` model routes.
3. Use `CODEX_BIN` only when the Codex delegate executable is not available as
   `codex` on `PATH`.
4. Keep provider keys on the service/worker side; never expose them through
   Review Room client code, preview smoke workflows, artifacts, or logs.

### Diagnose

1. Run:

   ```bash
   pnpm --filter @review-agent/review-cli dev doctor --provider all --json
   ```

2. Check provider policy telemetry in run status or Review Room. Safe summaries
   include final provider, model, fallback state, attempts, latency, usage
   status, and failure class.
3. Treat `usage.status="unknown"` spikes as an observability issue, not proof
   of zero cost.

### Rotate

1. Add the replacement provider key to the service/worker secret store.
2. Redeploy the service and worker.
3. Run `review-agent doctor --provider all --json` from a trusted host.
4. Submit a small disposable review on the affected route and confirm provider
   telemetry reports the expected final provider/model.
5. Revoke the old key at the provider after the smoke passes.

## Vercel Workflow and Sandbox

### Workflow

1. Detached runs require Workflow runtime availability. If Workflow cannot
   accept a run, the service records a failed terminal start instead of falling
   back to process-local success.
2. Reconcile active detached runs through status/list routes, which query
   Workflow and persist terminal snapshots into the service store.
3. Cancellation is terminal only after Workflow reports `cancelled`; accepted
   but pending cancellation returns `202` with `cancelled: false`.

### Sandbox

1. `remoteSandbox` currently requires detached delivery and custom targets.
   Git-backed remote sandbox targets remain blocked until source binding exists.
2. Default policy denies network, limits commands/output/artifacts/wall time,
   redacts selected secret patterns, and returns sandbox audit metadata.
3. `bootstrap_then_deny` is only for explicit setup phases. Lock network back
   to deny-all before runtime commands.
4. Sandbox audit summaries are safe for operations; raw command stdout/stderr,
   env, prompts, and file contents are private by default.

## Review Room and Vercel Preview

### Deploy

1. Deploy `apps/review-web` as the Vercel project root.
2. Set `REVIEW_WEB_SERVICE_URL` to an HTTPS review-service origin.
3. Set `REVIEW_WEB_SERVICE_TOKEN` as a server-side encrypted variable.
4. Set `REVIEW_WEB_ACCESS_TOKEN` for production and preview so `proxy.ts` fails
   closed before any service-token-backed route work.
5. Keep `/api/health` reachable without Review Room browser credentials. It
   exposes only `ok`, access-token configured, production-runtime, and service
   token configured booleans.

### Smoke

1. Run the secret-free preview smoke:

   ```bash
   DEPLOYMENT_URL=https://<preview>.vercel.app node scripts/preview-smoke.mjs
   ```

2. Run the browser smoke:

   ```bash
   DEPLOYMENT_URL=https://<preview>.vercel.app bash scripts/agent-browser-preview-smoke.sh
   ```

3. For trusted manual dogfood only, export `REVIEW_WEB_ACCESS_TOKEN` and, when
   Vercel Deployment Protection blocks the preview before the app, export
   `VERCEL_AUTOMATION_BYPASS_SECRET`.

## CI and Release Gates

1. Before merging, require the stable `check` aggregator plus the upstream
   named lanes in [CI Hardening Runbook](../release/ci-hardening.md).
2. For schema or Rust changes, run `pnpm ci:contracts` and `pnpm rust:check`.
3. For dependency or supply-chain changes, run `pnpm ci:security`.
4. For docs-only changes with no docs-specific checker, run `pnpm check` and
   manually review doc navigation and links.
5. Resolve hosted review threads only after the fixing commit is pushed.

## Capacity and Rate-Limit Incidents

1. `429` from `POST /v1/review/start` means queue, global running, or
   per-scope runtime capacity is exhausted. Check structured
   `review.run.backpressure` logs and the durable list for nonterminal runs.
2. Reconcile active detached runs through `review-agent list` or status reads
   before increasing limits; stale Workflow state can make capacity appear full.
3. Endpoint rate limiting for repeated status, SSE, artifact, and cancel reads
   is currently owned by the deployment edge or API gateway. Inspect edge logs
   before changing app runtime limits.
4. Raise app capacity only after confirming provider cost, Workflow throughput,
   and Postgres connection capacity can absorb the increase.

## Incident Triage

1. Identify the blast radius: CLI-only, service API, Review Room, Workflow,
   Sandbox, provider, GitHub publication, storage, or CI.
2. Start with durable state, not raw logs:

   ```bash
   review-agent list --status failed --repo owner/name
   review-agent status <reviewId>
   ```

3. Correlate `reviewId`, `workflowRunId`, and `sandboxId` in Review Room,
   service structured logs, Vercel Runtime Logs, Workflow logs, and sandbox
   audit summaries.
4. Keep private diffs, prompts, cwd values, artifact bodies, stdout/stderr,
   environment values, and tokens out of incident notes unless the incident
   owner authorizes a sensitive debug channel.
5. Classify failures as request/authz, capacity/backpressure, provider,
   Workflow, Sandbox, storage, GitHub publication, or UI/proxy.
6. Fix forward with a small branch and keep the linked issue/PR evidence in the
   release ledger.

## References

- Divio documentation system: <https://documentation.divio.com/>
- Next.js App Router route handlers and proxy convention:
  <https://nextjs.org/docs/app>
- Vercel Workflow: <https://vercel.com/docs/workflow>
- Vercel Sandbox: <https://vercel.com/docs/vercel-sandbox>
- Vercel automated agent access:
  <https://vercel.com/docs/deployment-protection/automated-agent-access>
