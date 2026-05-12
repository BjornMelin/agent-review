# ADR-0005: Durable Review Storage

- Status: Accepted
- Date: 2026-05-11

## Amendment - 2026-05-12

Follow-up roadmap issues have attached auth ownership, Review Room views,
GitHub publication state, finding triage, and run observability metrics to the
same durable store. This ADR remains the storage decision record; current table
ownership and route contracts are in
[Review Service API](../spec/review-service-api.md).

## Context

The review service started with a process-local store for run status, lifecycle
event replay, and generated artifacts. That was sufficient for early route
contracts, but it could not survive service restarts, support operational
queries, retain artifact metadata independently from response bodies, or provide
stable cleanup semantics.

Vercel Workflow can coordinate detached execution, retries, and resumption, but
it is not the service's queryable system of record. The service needs durable
run state that keeps endpoint payloads stable while making lifecycle history and
artifact metadata available to API routes, diagnostics, and future hosted UI
surfaces.

## Decision

Use PostgreSQL with Drizzle ORM as the service durable store for review run
state.

The service store owns:

- review runs keyed by `reviewId`
- request summaries for operational filtering
- lifecycle events with per-review sequence numbers
- artifact metadata, checksums, content types, and storage keys
- generated artifact content for the current service implementation
- redaction-safe run metrics for status/list, CLI, and Review Room summaries
- status-transition audit rows
- retention and deletion timestamps

`apps/review-service/src/storage/schema.ts` is the Drizzle schema source.
`apps/review-service/drizzle/0000_initial_review_storage.sql` is the initial SQL
migration. The production entrypoint chooses the Drizzle/node-postgres store
when `DATABASE_URL` or `POSTGRES_URL` is configured. Local no-database
development can use the async in-memory adapter, but `NODE_ENV=production`
fails without a database URL unless `REVIEW_SERVICE_STORAGE=memory` explicitly
accepts volatile state.

The HTTP endpoint contract does not change. Route code talks to
`ReviewStoreAdapter`, and durable storage is covered by PGlite-backed contract
tests so migration shape, stale-record event appends, cursor replay, restart
hydration, artifact metadata, retention cleanup, status transitions, and cascade
deletion stay executable without an external Postgres service.

Detached Workflow run identifiers and observed states are persisted through the
same service store. Workflow coordinates execution and retries; it does not own
queryable run, event, or artifact state.

## Consequences

### Positive

- Service status, event replay, and artifact reads survive service restarts.
- Review state has a queryable schema instead of opaque process memory.
- Artifact metadata can be inspected without parsing generated artifact bodies.
- Storage tests exercise real SQL semantics without requiring hosted
  infrastructure.
- The service can attach auth ownership, Review Room views, retention jobs,
  GitHub publishing state, finding triage, and observability metrics to the same
  run record.

### Negative

- Hosted deployments now need a PostgreSQL-compatible database for durable
  behavior.
- The service carries migration ownership in addition to route contracts.
- Detached execution now depends on Workflow acceptance for background work, so
  local no-database development still needs Workflow runtime availability for
  detached mode.

## Alternatives Considered

- Keep process-local memory: rejected because it loses state on restart and
  blocks hosted durability.
- Use Vercel Workflow as the store: rejected because workflow orchestration is
  not a queryable run/event/artifact database.
- Use a document store first: rejected because the run, event, artifact, and
  transition model benefits from relational constraints, indexes, and cascade
  deletion.
- Add a new shared package immediately: deferred to avoid a broader package
  split before the service storage contract settles.

## References

- `apps/review-service/src/storage/schema.ts`
- `apps/review-service/src/storage/index.ts`
- `apps/review-service/src/storage/index.test.ts`
- `apps/review-service/drizzle/0000_initial_review_storage.sql`
- `docs/architecture/spec/system-overview.md`
- `docs/architecture/spec/review-service-api.md`
- https://orm.drizzle.team/docs/get-started-postgresql
- https://orm.drizzle.team/docs/transactions
- https://node-postgres.com/features/transactions
