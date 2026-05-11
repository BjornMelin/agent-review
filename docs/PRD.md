# Product Requirements Document

## Product

Review Agent Platform (`v0.1.0`)

## Problem Statement

Engineering teams need repeatable, machine-readable code review output that can run locally, through services, and in detached workflows while preserving strong schema guarantees and actionable severity signaling.

## Goals

- Provide a consistent review contract across CLI and HTTP surfaces.
- Support multiple provider backends through a shared interface.
- Produce deterministic artifacts (`json`, `markdown`, `sarif`) for automation and human consumption.
- Validate finding locations against changed diff lines to reduce false-positive locations.
- Support detached execution for longer-running review tasks.
- Preserve a TypeScript control plane while allowing narrowly gated Rust helpers
  that delete fragile implementation paths.

## In Scope (Current Implementation)

- CLI command surface (`run`, `models`, `doctor`, `completion`)
- HTTP review service with start/status/events/cancel/artifacts endpoints
- Detached worker integration with Workflow API and durable service state
- Durable Postgres/Drizzle service storage for review runs, lifecycle events,
  artifact metadata, status transitions, and retention markers
- Review targets: uncommitted changes, base branch comparison, commit SHA, custom instructions
- Provider modes:
  - Codex delegate (`codexDelegate`)
  - OpenAI-compatible (`gateway:*`, `openrouter:*`)
- Provider construction, model defaults, model catalog presets, and doctor
  filtering are owned by `packages/review-provider-registry`.
- Optional sandbox preflight for remote execution mode
- Optional Convex metadata mirror writes

## Out of Scope (Current Implementation)

- Authentication and authorization layer on HTTP endpoints
- Multi-tenant isolation, quotas, and billing
- Provider-specific retry classification beyond Workflow step retry defaults
- UI frontend for review authoring or visualization
- Rust service rewrites, native primary CLI rewrites, Ratatui TUIs, and Tauri
  desktop applications

## Primary Users

- Developers running local/CI checks through CLI
- Internal services orchestrating review via HTTP API
- Platform engineers integrating review outputs into downstream tooling

## Success Criteria

- A valid `ReviewRequest` yields a schema-valid `ReviewResult` or a clear failure.
- Artifact generation is deterministic and available per requested output format.
- Severity threshold mapping produces predictable process exit behavior.
- Detached runs can be started, polled, and cancelled through service APIs.

## Non-Functional Expectations

- Strict runtime validation with Zod at API and provider boundaries
- TypeScript strict mode across monorepo packages
- Reproducible pipeline (`lint`, `typecheck`, `test`, `build`) through root scripts
- Architecture changes that introduce Rust helpers must follow
  [ADR-0004](./architecture/adr/0004-typescript-control-plane-and-rust-helper-boundary.md):
  generated contracts, conformance tests, benchmark gates, and no permanent
  dual canonical paths.
