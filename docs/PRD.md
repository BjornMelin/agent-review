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
- Provide an operational Review Room for hosted run visibility, triage, artifact
  access, and controlled publish/cancel actions.
- Preserve a TypeScript control plane while allowing narrowly gated Rust helpers
  that delete fragile implementation paths.
- Define gated native expansion paths only when they remain clients of the
  hosted service and generated contracts.

## In Scope (Current Implementation)

- CLI command surface for local reviews, hosted submission/list/status/watch,
  artifact fetch, cancel, publish, model catalog, diagnostics, and completion
- HTTP review service with start/list/status/events/cancel/artifacts/finding
  triage/publish preview/publish endpoints
- Scoped service-token and GitHub-backed authorization on hosted HTTP endpoints
- Detached worker integration with Workflow API and durable service state
- Runtime leases, queue/concurrency backpressure, and cancellation propagation
  through provider, sandbox, and Rust command-runner boundaries
- Durable Postgres/Drizzle service storage for review runs, lifecycle events,
  artifact metadata, status transitions, retention markers, and redaction-safe
  observability metrics
- Review targets: uncommitted changes, base branch comparison, commit SHA, custom instructions
- Provider modes:
  - Codex delegate (`codexDelegate`)
  - OpenAI-compatible (`gateway:*`, `openrouter:*`)
- Provider construction, model defaults, model catalog presets, and doctor
  filtering are owned by `packages/review-provider-registry`.
- OpenAI-compatible provider policy includes an allowlisted model catalog,
  explicit fallback order, input/output budgets, per-attempt timeouts,
  data-retention metadata, prompt-training controls, safe failure
  classification, and successful-run token/cost/latency telemetry when exposed
  by the AI SDK/Gateway.
- Detached remote sandbox execution for custom targets with deny-all policy
  runner, artifact extraction, and sandbox audit propagation
- Next.js Review Room with dense hosted run list, detail, lifecycle timeline,
  finding table, triage filters/state/notes, artifact links, provider/model
  metadata, run metrics, publication preview/evidence, and server-side
  publish/cancel controls. The UI is an operations console: the run list is the
  first screen, and run detail pages are optimized for triage, artifact access,
  lifecycle replay, and controlled GitHub publication.
- Optional Convex metadata mirror writes

## Out of Scope (Current Implementation)

- Browser-native GitHub OAuth/session management for Review Room beyond the
  current service-token deployment shell
- Billing and customer-specific quota products beyond the current service-level
  scope controls
- Provider-token execution inside Vercel Sandbox before hosted auth/source
  binding is implemented
- Git-backed remote sandbox target execution before sandbox source binding is
  implemented
- Review authoring flows beyond the existing CLI/API start and submit paths
- Implemented Rust service rewrites, native primary CLI rewrites, Ratatui TUIs,
  and Tauri desktop applications. The Ratatui console is accepted only as a
  design-gated expansion track in
  [ADR-0007](./architecture/adr/0007-ratatui-review-console.md). Tauri desktop
  remains deferred by
  [ADR-0008](./architecture/adr/0008-tauri-desktop-expansion-gate.md) unless
  web, CLI, and Ratatui evidence proves desktop-only value and a release owner
  accepts capabilities, IPC, updater, signing, and support obligations.
- Customer billing, tenant administration, and external self-serve onboarding

## Primary Users

- Developers running local/CI checks through CLI
- Internal services orchestrating review via HTTP API
- Review Room operators triaging hosted runs, artifacts, and publish/cancel
  state
- Platform engineers integrating review outputs into downstream tooling

## Success Criteria

- A valid `ReviewRequest` yields a schema-valid `ReviewResult` or a clear failure.
- Artifact generation is deterministic and available per requested output format.
- Severity threshold mapping produces predictable process exit behavior.
- Detached runs can be started, polled, and cancelled through service APIs.
- Hosted run lists and run details can be loaded through Review Room without
  exposing bearer tokens to the browser.
- Operators can identify failed, backpressured, cancelled, sandboxed, and
  publication-ready runs from durable summaries without reading raw provider
  output or private repository material from logs.
- Cancellation responses only report terminal success after the runtime reports
  `cancelled`; capacity exhaustion returns retryable `429` errors instead of
  accepting unbounded work.

## Non-Functional Expectations

- Strict runtime validation with Zod at API and provider boundaries
- TypeScript strict mode across monorepo packages
- Reproducible pipeline (`lint`, `typecheck`, `test`, `build`) through root scripts
- Architecture changes that introduce Rust helpers must follow
  [ADR-0004](./architecture/adr/0004-typescript-control-plane-and-rust-helper-boundary.md):
  generated contracts, conformance tests, benchmark gates, and no permanent
  dual canonical paths.
- Desktop application work must follow
  [ADR-0008](./architecture/adr/0008-tauri-desktop-expansion-gate.md): no Tauri
  implementation without a new approval issue, generated contracts, least
  privilege capabilities, token-storage controls, signed updater policy, and
  platform support ownership.
