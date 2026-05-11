# ADR-0006: Durable Workflow Detached Execution

- Status: Accepted
- Date: 2026-05-11

## Context

Detached review execution initially used Vercel Workflow when available and
silently fell back to process-local async execution when Workflow APIs failed.
That kept local demos easy, but it split canonical state across Workflow, the
service store, and an in-memory worker map. A restarted worker could no longer
reconcile or cancel a Workflow run unless the local map still contained the run.

ADR-0005 made PostgreSQL/Drizzle the queryable service store for run state,
lifecycle events, artifacts, and status transitions. Detached execution should
use that store as the service-facing state boundary and let Workflow only
orchestrate background execution.

## Decision

Hard-cut production local detached fallback state from `review-worker`.

- `review-service` persists a queued `ReviewRecord` before dispatching detached
  work.
- `review-worker` starts `reviewWorkflow` through `@workflow/core/runtime` and
  returns the Workflow run ID as both `detachedRunId` and `workflowRunId`.
- `review-service` persists the Workflow run ID, observed queued/running state,
  and all replayable lifecycle events through `ReviewStoreAdapter`.
- `ReviewWorker.get(runId)` and `ReviewWorker.cancel(runId)` query Workflow by
  run ID directly, so status reads and cancellation survive worker restarts.
- If Workflow cannot accept a detached run, the service records a failed
  terminal state and returns an error instead of reporting local fallback
  success.
- The review execution step declares an explicit retry budget on the Workflow
  step; provider-specific retry classification remains a later policy concern.

## Consequences

### Positive

- Detached status and cancellation no longer depend on worker process memory.
- Service status, SSE replay, artifact readiness, and terminal errors share one
  durable state boundary.
- Workflow failures at start are visible instead of hidden behind non-durable
  local execution.
- The worker implementation is smaller because it no longer owns retention,
  cleanup, or process-local run state.

### Negative

- Detached mode now requires Workflow runtime availability.
- Local development without Workflow support can still use inline execution, but
  detached start requests fail visibly.
- Workflow integration tests still rely on mocked runtime boundaries until the
  repo adopts the Workflow Vitest harness.

## Alternatives Considered

- Keep local fallback: rejected because it contradicts durable detached state and
  loses status/cancel ability after worker restart.
- Move the Drizzle store into `review-worker`: rejected because the service is
  the HTTP/API owner and already owns status/event/artifact persistence.
- Use Workflow as the only store: rejected because Workflow is not the queryable
  run/event/artifact database used by service routes and future UI surfaces.

## References

- `apps/review-worker/src/index.ts`
- `apps/review-worker/src/index.test.ts`
- `apps/review-service/src/app.ts`
- `apps/review-service/src/app.test.ts`
- `docs/architecture/spec/sandbox-detached-and-mirroring.md`
- `docs/architecture/spec/review-service-api.md`
- https://vercel.com/docs/workflow
- https://useworkflow.dev/docs/api-reference/workflow-api/start
- https://useworkflow.dev/docs/api-reference/workflow-api/get-run
- https://useworkflow.dev/docs/foundations/errors-and-retries
