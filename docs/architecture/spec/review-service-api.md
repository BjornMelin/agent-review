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
dependencies and calls `serve()`.

The service store uses the async `ReviewStoreAdapter` boundary exported from
`apps/review-service/src/storage/index.ts`. Production startup selects a
Drizzle/node-postgres store when `DATABASE_URL` or `POSTGRES_URL` is configured.
No-database local development falls back to `createInMemoryReviewStore()` with
the same async contract. `NODE_ENV=production` requires `DATABASE_URL` or
`POSTGRES_URL` unless volatile memory is selected explicitly with
`REVIEW_SERVICE_STORAGE=memory`.

Drizzle schema and migration ownership lives in `apps/review-service`:

- `src/storage/schema.ts`
- `drizzle/0000_initial_review_storage.sql`
- `drizzle/0001_review_runtime_control.sql`
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
  "delivery": "inline"
}
```

- `request`: required `ReviewRequest`
- `delivery`: optional `inline|detached` (default `inline`)

Detached mode is active when `delivery=detached` or `request.detached=true`.
The request body is parsed by `ReviewStartRequestSchema`.

### Responses

- `200`: inline run finished; response includes `result` summary payload
- `202`: detached accepted; response includes `detachedRunId`
- `400`: request parse/validation error
- `429`: runtime queue, global concurrency, or per-scope active-run limit reached
- `502`: worker or storage startup error

### Runtime Capacity

The service atomically reserves runtime capacity before dispatching inline or
detached work. Tunables live in `ReviewServiceConfig`:

- `maxQueuedRuns`
- `maxRunningRuns`
- `maxActiveRunsPerScope`
- `runtimeLeaseTtlMs`

Every accepted run receives a service-owned lease with `owner`, `scopeKey`,
`acquiredAt`, `heartbeatAt`, and `expiresAt`. `maxQueuedRuns` bounds queued
records, while `maxRunningRuns` bounds all live leased records that have not
reached a terminal state. The current scope key is derived from execution mode,
provider, canonicalized cwd, and target identity. Nonterminal leased rows keep
counting against capacity even after their lease expiry timestamp until service
reconciliation reaches a terminal status. Legacy unleased queued or running rows
also count against the global queue/running limits during the `maxRecordAgeMs`
upgrade-drain window; their scoped limit is reconstructed from the persisted
request when the service supplies a scope-key derivation callback. Expired leased
rows are marked `failed` with `runtime lease expired` when the run is next
reconciled.
Nonterminal detached Workflow status refreshes only unexpired leases, while
terminal Workflow status is still reconciled after lease expiry. Workflow
remains the execution orchestrator; `ReviewStoreAdapter` remains the queryable
lease/status source of truth.

## `GET /v1/review/:reviewId`

Returns review status and result summary when available.

### Response Fields

- `reviewId`
- `status`
- `error` (optional)
- `result` (optional review result payload)
- `createdAt`
- `updatedAt`

Returns `404` when review ID is unknown.
The response body follows `ReviewStatusResponseSchema`.

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
reports `cancelled`. Terminal, unknown, inline-only, duplicate, or lease-expired
requests return `409` with `cancelled: false`.

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
- Authentication defaults to allow-all through an injected auth policy hook.
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
