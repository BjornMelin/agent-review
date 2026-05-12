# ADR-0007: Ratatui Review Console Expansion Gate

- Status: Accepted
- Date: 2026-05-12
- Issue: [#33](https://github.com/BjornMelin/agent-review/issues/33)

## Context

The platform now has three stable operator surfaces:

- TypeScript CLI hosted commands for submit, list, status, watch, artifact,
  cancel, publish, diagnostics, and completion.
- Hosted review service APIs for run state, lifecycle SSE, finding triage,
  artifact retrieval, publication preview, publish, and cancellation.
- Next.js Review Room for browser-based run history, triage, artifacts, metrics,
  and controlled GitHub publication.

ADR-0004 keeps TypeScript as the product and orchestration control plane and
allows Rust only when it deletes fragile implementation or adds a clearly
separate product surface after service contracts stabilize. A terminal console
can be valuable for operators who live in shells, SSH sessions, tmux panes, and
CI-adjacent workflows, but it must not create a second review engine, schema
source, publish path, or authorization boundary.

Current Rust/library evidence:

- Ratatui 0.30.0 provides the current terminal UI stack, including
  `ratatui::run()` for terminal lifecycle setup/restore, modular workspace
  crates, default layout cache in the application crate, crossterm backend
  flexibility, and `TestBackend` for buffer-level rendering tests.
- Clap 4 derive remains the right parser when a native binary later needs
  subcommands, typed enums, shell completions, and predictable error handling.
- `reqwest-eventsource` 0.6.0 provides a reqwest-based EventSource wrapper for
  service SSE consumption.

## Decision

Approve a Ratatui Review Console as a gated expansion track, not as current
runtime work.

The TUI may be implemented only after the hosted service API and generated
contract path are stable enough for a Rust client to consume without hand-owned
DTOs. It must remain a client over the hosted service APIs described in
[Review Service API](../spec/review-service-api.md) and
[CLI Contract](../spec/cli-contract.md).

The first implementation, if approved, should be a dedicated native client
binary such as `review-console`, not a replacement for `review-agent`. The
existing TypeScript CLI remains the primary scriptable and CI interface.

Mandatory boundaries:

- `packages/review-types` remains the schema source of truth.
- Rust console DTOs are generated from committed JSON Schema artifacts or
  parsed through generated contract helpers before application use.
- The console reads and mutates only through hosted service endpoints.
- The console does not collect local diffs, invoke providers, run Codex,
  publish to GitHub directly, or bypass service authorization.
- Scoped service tokens and GitHub-backed bearer tokens follow the same
  precedence and redaction rules as hosted CLI commands.
- Interactive terminal rendering is disabled unless stdin, stdout, and stderr
  are TTYs. `CI=true` disables interactive rendering by default even when a
  pseudo-TTY is present; an explicit interactive override requires a later
  implementation decision and tests. Users should use the existing
  JSON-producing CLI commands in CI and pipelines.

## Product Shape

The console should optimize for dense operator work:

- run list with status, provider, model, repository, PR, updated time, findings,
  and safe metrics.
- live run detail that combines status, metrics, lifecycle events, artifacts,
  publication preview, and control state.
- finding triage workspace with filters, notes, reviewer-owned state, changed
  path/line context, and publication evidence.
- artifact viewer/downloader that preserves raw artifact bytes through service
  retrieval rather than embedding rendered Markdown as executable content.
- explicit cancel and publish confirmation flows backed by service responses.

The keyboard model must be discoverable and non-modal by default: global quit,
help, refresh, focus movement, filter, open run, open artifact, save triage,
cancel, and publish commands must be visible in a footer or help overlay.
Actions that mutate state require confirmation and must show the service result.

## Consequences

### Positive

- Gives terminal-first operators a faster review workflow without asking them
  to leave SSH/tmux or browserless environments.
- Reuses the same service authorization, durable state, triage, publication,
  metrics, and artifact APIs as Review Room.
- Keeps CI and automation on the existing machine-readable TypeScript CLI.
- Creates a clear pre-Tauri validation step for whether a native product surface
  has enough demand to justify desktop distribution.

### Negative

- Adds another client surface to document, test, and support after it is
  implemented.
- Terminal accessibility and layout quality require explicit testing across
  narrow viewports, low-color terminals, screen readers, and non-interactive
  shells.
- Rust client generation must stay tied to the TypeScript schema pipeline, which
  adds release friction if service DTOs churn.

## Alternatives Considered

- Implement the TUI immediately: rejected because the current issue can make the
  decision durable without adding a second client before the launch signoff.
- Replace the TypeScript CLI with a Rust CLI/TUI: rejected because the existing
  CLI is the scriptable CI interface and already shares package contracts with
  the service.
- Build Tauri first: rejected because desktop IPC, token storage, updater, and
  capability design should wrap a proven service client shape.
- Keep terminal UX as plain CLI commands only: rejected as a long-term position
  because live triage, lifecycle streaming, artifact browsing, and publication
  preview benefit from persistent terminal state.

## References

- [Native Review Console Spec](../spec/native-review-console.md)
- [ADR-0004 TypeScript Control Plane and Rust Helper Boundary](./0004-typescript-control-plane-and-rust-helper-boundary.md)
- [Review Service API](../spec/review-service-api.md)
- [CLI Contract](../spec/cli-contract.md)
- [Schema and Provider Contracts](../spec/schema-and-provider-contracts.md)
- https://ratatui.rs/highlights/v030/
- https://docs.rs/ratatui/latest/ratatui/
- https://docs.rs/clap/latest/clap/_derive/
- https://docs.rs/reqwest-eventsource/latest/reqwest_eventsource/
