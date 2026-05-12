# System Overview

## Purpose

The system performs automated review of code changes and returns prioritized findings with deterministic artifacts.

## Runtime Topology

ADR-0004 defines the language boundary for the roadmap: TypeScript remains the
control plane for service, worker, providers, Vercel Workflow/Sandbox
orchestration, shared Zod contracts, CLI, and Review Room. Rust is
admissible only for helper crates that delete fragile implementation details and
pass parity, benchmark, and generated-contract gates.
ADR-0007 accepts a future Ratatui Review Console only as a hosted-service client
over generated contracts; it is not a runtime, provider, GitHub publisher, or
replacement for the TypeScript CLI.

### Applications

- `apps/review-cli`: user-facing CLI to run reviews locally.
- `apps/review-service`: HTTP API for orchestration and streaming lifecycle
  events. The route layer is constructed through `createReviewServiceApp(deps)`
  so tests and future durable/auth integrations inject providers, worker, store,
  clock, UUID, logger, auth, and runner dependencies without binding a TCP port.
- `apps/review-web`: Next.js Review Room for hosted run history, run detail,
  lifecycle replay/live updates, findings, artifacts, provider metadata, and
  publish/cancel controls. It performs service reads server-side and proxies
  browser mutations/artifact/event requests through route handlers so bearer
  tokens stay out of browser JavaScript.
- `apps/review-worker`: detached execution adapter used by service.

### Core Packages

- `review-core`: orchestrates diff collection, prompt resolution, provider execution, finding normalization, validation, and artifact rendering.
- `review-types`: shared schemas/types and provider interfaces.
- `review-git`: collects git patch text and delegates parse/filter/index work
  to the Rust diff-index helper.
- `review-prompts`: builds target-specific prompt text and shared rubric.
- `review-provider-codex`: invokes Codex CLI delegate.
- `review-provider-openai`: invokes AI SDK gateway/openrouter models.
- `review-provider-registry`: owns provider construction, CLI provider/model
  normalization, default model policy, model catalog presets, and doctor
  filtering.
- `review-runner`: TypeScript adapter for the Rust process-group helper used
  by local-trusted command execution surfaces such as Codex delegation.
- `review-reporters`: renders `json`, `markdown`, and `sarif`.
- `review-sandbox-vercel`: policy-driven command execution wrapper for remote sandbox mode.
- `review-convex-bridge`: optional metadata write bridge.

### Rust Helper Workspace

- `review-contracts`: generated DTO parity and schema-validating parser helpers
  for committed `review-types` JSON Schema artifacts.
- `review-git-diff`: production stdin/stdout diff-index helper. It validates
  the generated `ReviewRequest` contract, parses unified git patches, applies
  include/exclude and byte/file budgets, and returns normalized chunks plus the
  changed-line index.
- `review-runner`: production stdin/stdout command runner. It validates the
  generated `CommandRunInput`/`CommandRunOutput` contracts, creates optional
  temporary directories, enforces process-group cancellation/timeouts/output
  limits, clears inherited process environment, redacts secret-like command
  metadata and output, reads requested temp files with byte caps, and performs
  explicit cleanup. The TypeScript adapter runs the helper under a filtered
  helper environment and gives it a graceful termination window before hard-kill
  fallback. Temp directory cleanup is best-effort and reports cleanup failures
  as structured command events rather than dropping command output.

Future native client work is documented in
[Native Review Console](./native-review-console.md). It must consume the
service list/status/events/artifacts/triage/publish/cancel APIs and cannot
collect diffs or execute providers locally.

## Core Data Flow

1. Runtime entrypoints normalize provider/model policy through
   `review-provider-registry` before calling core.
2. Core receives canonical `ReviewRequest` fields plus injected provider
   instances.
3. Request is parsed with `ReviewRequestSchema`.
4. Prompt is resolved from target (`review-prompts`).
5. Diff context is collected (`review-git`) and indexed by `review-git-diff`,
   which applies include/exclude paths and byte/file budgets before provider
   execution.
6. Selected provider executes using prompt + rubric + normalized diff chunks.
   OpenAI-compatible routing applies registry allowlist, fallback, input/output
   budgets, per-attempt timeout, and retention policy before calling the AI SDK.
   Local Codex delegation runs
   through `review-runner` so the command path has process-group
   timeout/cancellation and structured command telemetry.
7. Provider output is normalized to `ReviewResult` shape.
8. Command-run telemetry, when returned by a provider or attached to a provider
   failure, is surfaced through lifecycle progress correlation, including each
   structured runner event. Successful provider runs also include the command
   run in the review result. Successful OpenAI-compatible runs persist
   `providerTelemetry` with policy version, fallback attempts, final provider,
   usage/cost when reported, input/output/timeout budgets, retention flags, and
   latency.
9. Finding locations are normalized to absolute paths and validated against changed line index.
10. Artifacts are rendered for requested formats.
11. Optional mirror write is attempted.
12. Result and artifacts are returned.

## Persistence Model

- Service review records use the async `ReviewStoreAdapter` boundary.
- Production service startup uses a Drizzle/node-postgres store when
  `DATABASE_URL` or `POSTGRES_URL` is configured, and `NODE_ENV=production`
  fails without one unless volatile memory is explicitly selected.
- The durable schema stores review runs, request summaries, lifecycle events,
  artifact metadata/content, run metrics, status transitions, retention
  timestamps, and deletion markers.
- Local no-database development falls back to the same async adapter contract
  backed by an in-memory map.
- Detached Workflow run identifiers and observed states are persisted through
  the service store; the worker no longer keeps production canonical run state.
- Vercel Workflow coordinates execution, retries, and resumption; it does not
  replace queryable service run, event, or artifact state.

## Failure Behavior

- Schema violations fail fast.
- Provider invocation errors surface as review failures.
- Invalid finding line mappings raise explicit validation errors.
- Optional bridge failures are non-blocking.

## Observability Surface

- Lifecycle event model:
  - `enteredReviewMode`
  - `progress`
  - `exitedReviewMode`
  - `artifactReady`
  - `failed`
  - `cancelled`
- Service exposes event stream via SSE endpoint.
- Service persists redaction-safe `ReviewRunMetrics` summaries for status/list
  APIs, CLI `list`, and Review Room metadata, and emits structured
  `review.run.*` log records for platform log correlation.
- Review Room consumes run list/status/artifact APIs through server-side data
  loading and streams lifecycle updates through a token-safe SSE proxy route.
- Field-level allowlists and operator workflow live in
  [Observability Runbook](../../operations/observability.md).
