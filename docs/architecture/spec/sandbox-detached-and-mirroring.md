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

1. Attempt `@workflow/core/runtime` `start(reviewWorkflow, [request])`.
2. If workflow runtime APIs fail/unavailable, fallback to local async in-process
   run.

Run records expose:

- `runId`
- `status` (`queued|running|completed|failed|cancelled`)
- timestamps
- optional `error`
- optional `result`
- optional `workflowRunId`

`ReviewWorker.get` resolves current status and captures completed/failure outcomes when workflow API is active.

`ReviewWorker.cancel` attempts workflow cancellation and also updates local record state unless run is already terminal.

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
