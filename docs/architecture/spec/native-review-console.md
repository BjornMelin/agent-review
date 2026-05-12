# Native Review Console Spec

Status: Accepted design gate
Issue: [#33](https://github.com/BjornMelin/agent-review/issues/33)

## Purpose

The native Review Console is a future Ratatui terminal client for hosted review
operations. It is a client over the hosted service. It is not a review runtime,
provider host, GitHub publisher, schema source, or replacement for the
scriptable TypeScript CLI.

## Non-Goals

- No local review engine.
- No direct GitHub Checks, SARIF, or PR-comment writes.
- No direct provider, Codex, Vercel Workflow, or Vercel Sandbox execution.
- No hand-maintained Rust DTOs for service payloads.
- No interactive TUI behavior unless stdin, stdout, and stderr are TTYs.
- No default interactive TUI behavior in CI, even when CI allocates a
  pseudo-TTY.
- No Tauri or desktop packaging work under this decision.

## Runtime Boundary

The console consumes the same hosted service surfaces used by Review Room and
hosted CLI commands:

| Console capability | Service/API owner |
| --- | --- |
| Run list and filters | `GET /v1/review` |
| Run detail, result, metrics, artifacts, publications, triage | `GET /v1/review/:reviewId` |
| Live lifecycle events | `GET /v1/review/:reviewId/events` |
| Artifact retrieval | `GET /v1/review/:reviewId/artifacts/:format` |
| Finding triage mutation | `PATCH /v1/review/:reviewId/findings/:fingerprint/triage` |
| Publication preview | `GET /v1/review/:reviewId/publish/preview` |
| Publish | `POST /v1/review/:reviewId/publish` |
| Cancel | `POST /v1/review/:reviewId/cancel` |

The console must parse service responses through generated contracts derived
from `packages/review-types/generated/json-schema/`. Runtime validation failures
are user-visible client errors and must not be recovered by accepting partial
unchecked payloads.

## Auth and Configuration

Configuration precedence starts with the current hosted CLI pattern:

1. explicit flags
2. environment variables
3. defaults

Project config, user config, credential storage, and OS keychain integration
require a later ADR before implementation. They are not implied by this design
gate.

Config files must not store literal bearer tokens unless a later ADR explicitly
accepts local privileged token storage. Future config may store only non-secret
references, such as environment variable names or credential-store keys, until
that decision exists.

Required options:

- service URL
- bearer token source
- repository filter for multi-repository principals
- output/log verbosity
- color mode: auto, always, never
- refresh interval and event replay limit

Remote service URLs must require HTTPS except loopback, matching the hosted CLI
contract. Error messages must redact bearer tokens regardless of whether they
came from flags, environment, or config.

## Screens

### Run List

The first screen is a run table, not a landing page.

Columns:

- status
- repository and PR/ref/commit target
- provider/model
- execution mode
- finding count
- publish readiness
- updated time
- safe metrics summary

Controls:

- use service-backed filters for status and repository.
- apply local page filters for target, provider, model, and text search until
  the service API/schema explicitly adds server-side query fields.
- sort the loaded page locally by updated time, status, findings, duration,
  provider, and repository. Cross-page sorting requires a service API/schema
  change before the console can depend on it.
- open selected run detail.
- refresh manually or follow the configured refresh interval.

### Run Detail

The detail screen composes:

- summary header with status, target, provider, model, repository, PR, and
  timings.
- live lifecycle timeline from SSE replay plus live events.
- metrics panel with queue, provider, sandbox, artifact, and lease summaries.
- tabs or panes for findings, artifacts, publication preview, and raw-safe
  status evidence.

The detail view must tolerate missing optional fields by showing explicit
unavailable states, not by panicking or hiding controls without explanation.

### Finding Triage

The finding workspace should mirror Review Room semantics:

- immutable provider finding fields remain read-only.
- reviewer-owned state can be edited through the triage endpoint.
- note drafts are local until saved.
- save failures restore the prior durable state and keep the draft visible.
- publication status is derived from service publication records and preview
  data, not inferred from local state.

Filters:

- priority
- triage state
- provider
- publication state
- changed path
- reviewer/search text

### Artifact Viewer

Artifacts are fetched from the service and treated as untrusted content.

- Every provider-controlled string rendered to the terminal must be sanitized
  for terminal control sequences before drawing. This includes artifact content,
  JSON/SARIF string values, Markdown, finding bodies, paths, lifecycle text,
  service errors, status evidence, and publication evidence.
- JSON and SARIF can be pretty-printed in read-only panes only after
  terminal-safe escaping.
- Markdown can be shown as escaped plain text or downloaded.
- Raw artifact downloads must preserve bytes from the service response.
- Large artifacts require paging and byte counters rather than unbounded memory
  rendering.

### Publish and Cancel

Mutating actions require confirmation:

- cancel shows current status and whether cancellation is still possible.
- publish shows publication preview counts and stale-target blockers before the
  POST.
- both actions display the service response and refresh the run detail after
  completion.

## Keyboard and Accessibility

The console must be usable without a mouse.

Required conventions:

- `q`: quit or back out of overlays.
- `?`: help overlay.
- `Tab` / `Shift+Tab`: cycle focus.
- arrow keys or `j`/`k`: move within lists.
- `/`: search or filter.
- `r`: refresh.
- `Enter`: open selected item or confirm focused control.
- `Esc`: cancel edit/overlay.

Accessibility requirements:

- visible focus indicator on every interactive region.
- no color-only status; include labels, symbols, or text.
- color mode respects no-color and low-color terminals.
- terminal width below the minimum supported layout switches to a single-column
  fallback with abbreviated columns.
- text truncation preserves the most useful side of paths and IDs.
- help and mutation confirmations are reachable by keyboard and have stable
  labels.

## Implementation Shape

If implementation is approved, the crate should use:

- `ratatui` 0.30.x for terminal UI, layout, widgets, and `TestBackend`.
- `ratatui::run()` or explicit `try_init`/`try_restore` when the app needs
  tighter terminal error control.
- Ratatui crossterm compatibility features instead of adding an incompatible
  crossterm version.
- `clap` 4 derive for subcommands, typed flags, completions, and help.
- `reqwest` for REST calls.
- `reqwest-eventsource` for lifecycle SSE.
- generated DTO parsing from `crates/review-contracts`.

`crates/review-contracts` is the Rust contract and parser owner. If the console
needs service DTOs that the crate does not yet expose, the implementation must
extend `crates/review-contracts` and its gates before TUI code consumes those
payloads. A separate generated client crate would be a new architecture
decision, not part of this design gate.

Architecture:

- `AppState`: immutable configuration plus current screen, selection, loaded
  runs, details, filters, drafts, and pending mutations.
- `Action`: UI intent and external event messages.
- `update`: pure state transitions where possible.
- `render`: pure Ratatui widgets from state to buffer.
- `ServiceClient`: async boundary for HTTP/SSE calls.
- bounded channels between input, network, and render loops.

Network and terminal loops must be cancellable. A stuck service request,
truncated SSE stream, or terminal resize must not leave raw mode active or
orphan a background task.

## Validation Requirements

Design-only changes require:

- docs link/index check
- architecture review
- security review against the hosted-service client boundary

Implementation requires:

- `cargo fmt --all -- --check`
- `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`
- `cargo test --workspace --all-targets --all-features --locked`
- buffer/snapshot tests for all screens at normal and narrow terminal sizes
- reducer tests for focus, filters, drafts, errors, and mutation confirmation
- service client tests for auth redaction, HTTPS policy, schema failures,
  timeout/cancellation, SSE truncation, and retry behavior
- terminal sanitization tests with ANSI, OSC, control-byte, and multiline
  provider payload fixtures across findings, artifacts, lifecycle text, and
  errors
- stdio/CI gating tests covering stdin/stdout/stderr TTY combinations,
  `CI=true`, and any future explicit interactive override
- configuration tests proving config-loaded token references do not log or
  persist literal bearer tokens
- manual terminal smoke in a real TTY
- docs screenshots or asciinema only after implementation ships

## Launch Gate

The first implementation PR may merge only when it proves that the TUI deletes
operator friction without adding a second authority. Any request to collect
local diffs, run providers, publish directly to GitHub, or store privileged
tokens locally must return to ADR review before code lands.
