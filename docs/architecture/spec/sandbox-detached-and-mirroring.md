# Sandbox, Detached Execution, and Mirroring

## Sandbox Execution (`review-sandbox-vercel`)

`runInSandbox` executes command batches under policy and budget controls, stages
explicit input files, and extracts caller-requested artifacts after command
completion.

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
- Command names must be executable names, not paths; staged scripts must be
  invoked through an allowlisted runtime such as `node`.
- Per-command timeouts are clamped by policy max.
- Output size accumulation is enforced across run.
- Wall-time budget is enforced across run.
- Selected secret patterns in stdout/stderr are redacted.
- For `bootstrap_then_deny`, commands may opt into `phase: 'bootstrap'`; network
  is switched to deny-all before the first runtime command and again after all
  bootstrap-only batches.
- Requested artifact files are read back through the sandbox filesystem API,
  redacted, and included in the returned execution output.
- Structured audit metadata is returned:
  - policy profile and allowlist sizes
  - consumed budgets (command count, wall time, output bytes, artifact bytes)
  - redaction counters
  - per-command timing/output/redaction records
- `maxArtifactBytes` is enforced on extracted artifact content.

## Service Integration

`remoteSandbox` is supported only through detached delivery. Inline HTTP
requests return `400` with `executionMode "remoteSandbox" requires detached
delivery` because the sandbox runner is owned by `review-worker`.

Detached remote sandbox flow:

1. `review-service` validates the request, persists a queued record, and starts
   `review-worker`.
2. `review-core` rejects git-backed remote sandbox targets before host Git
   access. The current safe path accepts only `custom` targets and prepares an
   empty diff context until sandbox source binding is implemented.
3. `review-worker` stages a bounded review input JSON and a fixed
   `review-runner.mjs` into Vercel Sandbox.
4. The worker runs exactly one `node review-runner.mjs` command under deny-all
   network with `CI` as the only allowed environment key.
5. The worker extracts `review-output.json`, parses it as provider-shaped output,
   and returns `sandboxAudit` with the sandbox ID, policy, budgets, redaction
   counters, and command audit records.
6. `review-service` persists the resulting `sandboxId`; lifecycle event
   correlation also includes `sandboxId` when available.

The current sandbox runner is intentionally policy-only: it proves remote
execution, artifact extraction, and audit propagation without injecting provider
tokens or running arbitrary package-manager commands in the microVM. Provider
execution and git-backed target review inside Vercel Sandbox remain gated on
later hosted auth/source-binding work.

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
- optional `sandboxId`

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
