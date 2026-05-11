# Sandbox, Detached Execution, and Mirroring

## Sandbox Execution (`review-sandbox-vercel`)

`runInSandbox` executes command batches under policy and budget controls.

The default Vercel Sandbox runtime is `node24`. Callers may explicitly request
`node22` or `python3.13` when a review workload requires a different runtime.

## Policy Model

- `commandAllowlist: Set<string>`
- `networkProfile: 'deny_all' | 'bootstrap_then_deny' | 'allowlist_only'`
- `allowlistDomains: string[]`
- `envAllowlist: Set<string>`
- `budget`:
  - `maxWallTimeMs`
  - `maxCommandTimeoutMs`
  - `maxCommandCount`
  - `maxOutputBytes`
  - `maxArtifactBytes`

Default policy (`createDefaultPolicy`) denies network, uses fixed command allowlist, and enforces conservative execution budgets.

## Enforcement Behavior

- Commands are schema-validated before execution.
- Commands outside allowlist are rejected.
- Per-command timeouts are clamped by policy max.
- Output size accumulation is enforced across run.
- Wall-time budget is enforced across run.
- Selected secret patterns in stdout/stderr are redacted.
- For `bootstrap_then_deny`, network policy is switched to deny-all after command phase.
- Structured audit metadata is returned:
  - policy profile and allowlist sizes
  - consumed budgets (command count, wall time, output bytes, artifact bytes)
  - redaction counters
  - per-command timing/output/redaction records
- `maxArtifactBytes` is enforced on serialized sandbox execution output.

## Service Integration

`review-service` currently rejects `executionMode=remoteSandbox` requests with `400` and does not invoke `runInSandbox`.

## Detached Execution (`review-worker`)

Detached runs are started via `ReviewWorker.startDetached(requestInput)`.

Execution strategy:

1. Persist the queued service record through `ReviewStoreAdapter`.
2. Start `@workflow/core/runtime` with `start(reviewWorkflow, [request])`.
3. Persist `detachedRunId`, `workflowRunId`, and queued acceptance without an
   immediate Workflow status read; status is reconciled through later
   `getRun(runId)` lookups.
4. If Workflow cannot accept the run, persist a failed terminal record and return
   an error instead of falling back to in-process success.

Run records expose:

- `runId`
- `status` (`queued|running|completed|failed|cancelled`)
- timestamps
- optional `error`
- optional `result`
- optional `workflowRunId`

`ReviewWorker.get` resolves current status directly from Workflow by run ID and
captures completed/failure outcomes. Service routes then persist the latest
snapshot, lifecycle events, artifact metadata, and retention state through the
durable store.

`ReviewWorker.cancel` checks Workflow status by run ID, skips terminal runs, and
delegates cancellation to Workflow. The service persists cancellation state and
replayable lifecycle events through `ReviewStoreAdapter`.

## Metadata Mirroring (`review-convex-bridge`)

`ConvexMetadataBridge` is optional and enabled only when `CONVEX_URL` is set.

On completion, core may call `mirrorWrite(reviewId, result)` with payload:

- `reviewId`
- `provider`
- `model`
- `findingsCount`
- `overallCorrectness`
- `summary`
- `completedAt`

Bridge failures are intentionally non-blocking and logged as warnings.
