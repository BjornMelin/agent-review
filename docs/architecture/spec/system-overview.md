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
- `apps/review-service`: HTTP API for orchestration and streaming lifecycle events.
- `apps/review-worker`: detached execution adapter used by service.

### Core Packages

- `review-core`: orchestrates diff collection, prompt resolution, provider execution, finding normalization, validation, and artifact rendering.
- `review-types`: shared schemas/types and provider interfaces.
- `review-git`: collects and parses unified diff context.
- `review-prompts`: builds target-specific prompt text and shared rubric.
- `review-provider-codex`: invokes Codex CLI delegate.
- `review-provider-openai`: invokes AI SDK gateway/openrouter models.
- `review-reporters`: renders `json`, `markdown`, and `sarif`.
- `review-sandbox-vercel`: policy-driven command execution wrapper for remote sandbox mode.
- `review-convex-bridge`: optional metadata write bridge.

## Core Data Flow

1. Request is parsed with `ReviewRequestSchema`.
2. Prompt is resolved from target (`review-prompts`).
3. Diff context is collected (`review-git`) and filtered (`review-core`) by include/exclude path and byte/file budgets.
4. Selected provider executes using prompt + rubric + normalized diff chunks.
5. Provider output is normalized to `ReviewResult` shape.
6. Finding locations are normalized to absolute paths and validated against changed line index.
7. Artifacts are rendered for requested formats.
8. Optional mirror write is attempted.
9. Result and artifacts are returned.

## Persistence Model

- Service review records are maintained in an in-memory map.
- Worker detached records are maintained in an in-memory map.
- No durable store is required for baseline behavior.
- The roadmap target is a Postgres/Drizzle store for durable run, event, and
  artifact metadata. Vercel Workflow coordinates execution, but does not replace
  queryable state.

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
