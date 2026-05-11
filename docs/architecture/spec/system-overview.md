# System Overview

## Purpose

The system performs automated review of code changes and returns prioritized findings with deterministic artifacts.

## Runtime Topology

ADR-0004 defines the language boundary for the roadmap: TypeScript remains the
control plane for service, worker, providers, Vercel Workflow/Sandbox
orchestration, shared Zod contracts, CLI, and the future Review Room. Rust is
admissible only for helper crates that delete fragile implementation details and
pass parity, benchmark, and generated-contract gates.

### Applications

- `apps/review-cli`: user-facing CLI to run reviews locally.
- `apps/review-service`: HTTP API for orchestration and streaming lifecycle
  events. The route layer is constructed through `createReviewServiceApp(deps)`
  so tests and future durable/auth integrations inject providers, worker, store,
  clock, UUID, logger, auth, and runner dependencies without binding a TCP port.
- `apps/review-worker`: detached execution adapter used by service.

### Core Packages

- `review-core`: orchestrates diff collection, prompt resolution, provider execution, finding normalization, validation, and artifact rendering.
- `review-types`: shared schemas/types and provider interfaces.
- `review-git`: collects and parses unified diff context.
- `review-prompts`: builds target-specific prompt text and shared rubric.
- `review-provider-codex`: invokes Codex CLI delegate.
- `review-provider-openai`: invokes AI SDK gateway/openrouter models.
- `review-provider-registry`: owns provider construction, CLI provider/model
  normalization, default model policy, model catalog presets, and doctor
  filtering.
- `review-reporters`: renders `json`, `markdown`, and `sarif`.
- `review-sandbox-vercel`: policy-driven command execution wrapper for remote sandbox mode.
- `review-convex-bridge`: optional metadata write bridge.

### Rust Helper Workspace

- `review-contracts`: generated DTO parity and schema-validating parser helpers
  for committed `review-types` JSON Schema artifacts.
- `review-git-diff`: diff parser/index candidate used by conformance fixtures
  and benchmarks only. TypeScript remains the production diff owner until a
  later issue proves parity, performance, and deletion value, then cuts over
  without a permanent dual path.

## Core Data Flow

1. Runtime entrypoints normalize provider/model policy through
   `review-provider-registry` before calling core.
2. Core receives canonical `ReviewRequest` fields plus injected provider
   instances.
3. Request is parsed with `ReviewRequestSchema`.
4. Prompt is resolved from target (`review-prompts`).
5. Diff context is collected (`review-git`) and filtered (`review-core`) by include/exclude path and byte/file budgets.
6. Selected provider executes using prompt + rubric + normalized diff chunks.
7. Provider output is normalized to `ReviewResult` shape.
8. Finding locations are normalized to absolute paths and validated against changed line index.
9. Artifacts are rendered for requested formats.
10. Optional mirror write is attempted.
11. Result and artifacts are returned.

## Persistence Model

- Service review records use the async `ReviewStoreAdapter` boundary.
- Production service startup uses a Drizzle/node-postgres store when
  `DATABASE_URL` or `POSTGRES_URL` is configured, and `NODE_ENV=production`
  fails without one unless volatile memory is explicitly selected.
- The durable schema stores review runs, request summaries, lifecycle events,
  artifact metadata/content, status transitions, retention timestamps, and
  deletion markers.
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
