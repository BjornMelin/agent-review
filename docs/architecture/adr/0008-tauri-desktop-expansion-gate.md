# ADR-0008: Tauri Desktop Expansion Gate

- Status: Accepted
- Date: 2026-05-12
- Issue: [#34](https://github.com/BjornMelin/agent-review/issues/34)

## Context

The platform already has launch-critical surfaces for the same review workflow:

- TypeScript CLI commands for local, CI, and hosted automation.
- Hosted review service APIs for run state, lifecycle events, artifacts,
  finding triage, publication preview, publish, and cancellation.
- Next.js Review Room for browser-based run history, triage, artifact access,
  metrics, and controlled GitHub publication.
- A future Ratatui Review Console accepted by
  [ADR-0007](./0007-ratatui-review-console.md) as a gated terminal client over
  hosted service APIs and generated contracts.

[ADR-0004](./0004-typescript-control-plane-and-rust-helper-boundary.md) keeps
TypeScript as the control plane and allows native work only when it deletes
fragile implementation or creates a separate client surface after service
contracts are stable. Tauri can provide a small desktop shell, operating-system
integration, and signed update distribution, but it also introduces a new IPC
boundary, local token custody, desktop release channels, code signing, updater
key custody, platform-specific packaging, and webview security obligations.

Current Tauri v2 guidance makes those costs explicit:

- Capabilities are the permission boundary for each window or webview. Broad
  filesystem, shell, opener, dialog, updater, and remote-origin permissions
  expand the impact of a compromised frontend.
- Rust commands are IPC contracts. Arguments and responses must be typed and
  serializable, with application-owned validation and structured errors.
- Shell sidecars require explicit allowlisted command permissions and must not
  accept arbitrary frontend-supplied binaries, args, paths, or environments.
- The updater plugin requires signed artifacts; the signing private key is a
  release-critical secret, and production update endpoints must use TLS.

## Decision

Do not implement a Tauri desktop application in the current roadmap.

Treat desktop as a deferred expansion gate that defaults to "do not build"
unless the shipped web, CLI, and Ratatui surfaces leave concrete desktop-only
user needs unresolved. A future implementation may start only after a new issue
and ADR update explicitly approve scope, support policy, distribution channels,
and security controls.

The minimum approval bar is:

- At least two validated desktop-only needs that web, CLI, and Ratatui cannot
  solve with less maintenance. Examples include managed enterprise desktop
  distribution, OS keychain-backed token UX, native notifications for long
  reviews, deep links/file associations, or controlled artifact file workflows.
- Stable service APIs and generated Rust contract helpers for every desktop
  payload the app consumes.
- A named owner for signing keys, release channels, platform packaging, updater
  metadata, vulnerability response, and desktop support.
- Security-review approval for capabilities, IPC, token storage, CSP,
  updater/signing, sidecar policy, and artifact handling.

If those conditions are not met, the product answer is to keep improving Review
Room, the TypeScript CLI, and the Ratatui console rather than adding desktop
distribution.

## Mandatory Boundaries

A future Tauri app must be a hosted-service client. It must not become a local
review runtime, provider host, GitHub publisher, schema owner, sandbox runner,
or replacement for the TypeScript CLI.

Required boundaries:

- `packages/review-types` remains the schema source of truth.
- Rust desktop DTOs are generated from committed JSON Schema artifacts or
  parsed through `crates/review-contracts` before application use.
- The app reads and mutates only through hosted service endpoints.
- The app does not collect local diffs, invoke providers, run Codex, call
  GitHub publish APIs directly, start Vercel Workflow/Sandbox work, or bypass
  service authorization.
- The existing TypeScript CLI remains the scriptable automation surface for
  CI, pipes, and shell workflows.
- Review Room remains the browser surface. A desktop shell cannot be used as a
  shortcut around missing hosted auth, same-origin mutation protection, or
  multi-user browser session design.

## Capability Policy

Start from no privileged capabilities. Add only narrow permissions that map to
approved product workflows.

Potentially admissible capabilities:

- platform secure storage or keychain access for a service token reference.
- opening external URLs through an allowlisted opener flow.
- native notifications for review lifecycle state.
- file save/open dialogs for explicit artifact import/export.
- updater check/download/install for signed releases.

Default-denied capabilities:

- arbitrary shell execution.
- broad filesystem read/write.
- remote-origin access to Tauri commands.
- sidecars.
- direct provider, GitHub, Vercel, or repository access.
- local repository scanning, diff collection, or custom command execution.

If a later ADR approves sidecars, each sidecar must be versioned, checksummed,
bundled or fetched through a verified release channel, declared in explicit
shell permissions, and owned by the Rust app lifecycle. Frontend code must not
choose the binary, command arguments, working directory, environment, or output
destination.

Capability files must be intentionally enabled in `tauri.conf.json`. Do not
rely on accidental auto-enabled capability files as the security model.

## IPC and Frontend Policy

Commands are public bridge contracts.

Requirements:

- Keep commands thin. They should call app-owned Rust services that wrap the
  hosted service client, credential store, updater, or notification provider.
- Every `#[tauri::command]` must appear in an approved command inventory that
  names the owning Rust service, accepted inputs, redacted outputs, allowed
  windows/webviews, required capability, and tests.
- Registered commands must be constrained with `tauri_build::AppManifest`
  command declarations rather than relying on the default all-command exposure.
  The manifest audit must fail on implicit all-window access, wildcard window
  labels, or unowned commands.
- Command scopes are defense in depth, not validation replacement. Command
  implementations must read and enforce any configured scope before touching
  tokens, files, URLs, updater state, notifications, or service mutations.
- Validate every IPC argument before use, including IDs, URLs, paths, filters,
  artifact formats, and pagination inputs.
- Return typed serializable results and structured errors; never expose raw
  stack traces, bearer tokens, provider prompts, raw private diffs, or unbounded
  service errors to the frontend.
- Use channels only for bounded progress streams such as updater/download
  progress or lifecycle event forwarding.
- Prefer commands for stable request/response contracts. Events are allowed for
  notifications and progress only when ordering, replay, and cancellation are
  tested.
- Treat artifact and provider strings as untrusted. Escape or sanitize content
  before webview display and before passing values into native dialogs,
  notifications, logs, or filenames.

The desktop frontend should reuse Review Room components only when it preserves
the same security posture. Remote Review Room pages must not receive Tauri
command access unless a future ADR accepts remote API access, origin allowlists,
capability scope, CSP, and token flow. Bundled assets are the safer default for
any privileged desktop UI.

Remote-origin command access also requires platform-specific approval. For
Linux desktop builds, remote-origin Tauri command access remains denied unless a
future ADR proves the iframe/window-origin ambiguity is mitigated and covered by
tests. Origin allowlists alone are not enough for a privileged desktop shell.

## Token and Configuration Policy

Bearer tokens are secrets and must not be stored in plaintext app config.

Requirements:

- Store only secure-storage references or non-secret configuration in files.
- Prefer OS keychain or an equivalent secure store for local credentials.
- Keep bearer tokens out of frontend JavaScript. Rust services attach tokens to
  hosted service requests and return redacted state to the UI.
- Preserve the hosted CLI token precedence model for any shared service client:
  explicit flags or launch context, environment, secure store, then defaults.
- Redact tokens and secret-like values from logs, errors, diagnostics,
  updater metadata, support bundles, and crash reports.
- Remote service URLs must require HTTPS except loopback development.

## Updater and Distribution Policy

A desktop app may ship only with a real release policy.

Required decisions before implementation:

- supported platforms and package formats: macOS DMG/app bundle, Windows
  MSI/NSIS, Linux AppImage/deb/rpm, or an intentionally smaller matrix.
- macOS signing and notarization owner.
- Windows signing owner.
- Linux package signing and repository policy, if repositories are used.
- stable, beta, and internal release-channel names.
- rollback and downgrade behavior.
- updater endpoint ownership, TLS requirement, cache policy, and monitoring.
- Tauri signing-key custody, rotation, backup, and incident response.
- smoke tests that verify signed artifact metadata before release promotion.

The updater signing private key must never be committed, checked into `.env`,
or exposed to frontend code. Production updater endpoints must use TLS.
Insecure updater transport is not allowed outside explicit local development
tests.

## Validation Requirements

Design-only changes require:

- documentation link/index checks.
- architecture review.
- security review against capabilities, IPC, token storage, updater, sidecar,
  and distribution boundaries.

Implementation requires:

- `pnpm check`
- `pnpm build`
- `cargo fmt --all -- --check`
- `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`
- `cargo test --workspace --all-targets --all-features --locked`
- Tauri build/package checks for each supported platform lane.
- capability manifest audit proving only approved permissions are enabled.
- command manifest audit proving every registered command is explicitly
  inventoried, mapped to allowed window/webview labels, and denied to
  lower-trust windows by default.
- IPC contract tests for input validation, redaction, error shape,
  cancellation, and schema failures.
- credential-store tests proving tokens do not persist in plaintext config or
  reach frontend JavaScript.
- updater metadata/signature smoke tests.
- webview security tests for CSP, remote-origin blocking, untrusted artifact
  rendering, and external-link handling.
- remote-origin command blocking tests for every supported platform lane,
  including Linux-specific iframe/window-origin behavior before any Linux build
  can allow remote Tauri APIs.
- manual desktop dogfood covering install, launch, auth, run list, run detail,
  artifact export, update check, logout/token removal, and uninstall behavior.

## Consequences

### Positive

- Prevents desktop distribution from becoming a workaround for unfinished
  hosted API, auth, or Review Room work.
- Keeps one review runtime, one schema owner, and one publish authority.
- Makes Tauri security and release obligations explicit before code exists.
- Preserves CLI and Ratatui as lower-maintenance native paths for operators.

### Negative

- Users who prefer a desktop app will wait until web, CLI, and TUI evidence
  proves the need.
- A future desktop implementation will require release engineering work before
  the first product feature can ship.
- Some Tauri-native capabilities may be rejected even if technically feasible
  because they duplicate hosted service authority or add support cost.

## Alternatives Considered

- Build Tauri now: rejected because it would add IPC, capabilities, updater,
  signing, token storage, and packaging before desktop-only value is proven.
- Use Tauri as a wrapper around the hosted Review Room: rejected as the default
  because remote web content plus Tauri command access is a high-risk boundary;
  bundled privileged UI or plain browser Review Room are safer defaults.
- Replace the TypeScript CLI with a Rust/Tauri native app: rejected because the
  CLI is the scriptable CI surface and already shares contracts with the
  TypeScript control plane.
- Never build desktop: rejected as an absolute rule because enterprise desktop
  distribution, secure local credential UX, native notifications, and file
  workflows may become valuable after launch evidence exists.

## References

- [ADR-0004 TypeScript Control Plane and Rust Helper Boundary](./0004-typescript-control-plane-and-rust-helper-boundary.md)
- [ADR-0007 Ratatui Review Console Expansion Gate](./0007-ratatui-review-console.md)
- [Native Review Console Spec](../spec/native-review-console.md)
- [Review Service API](../spec/review-service-api.md)
- [CLI Contract](../spec/cli-contract.md)
- https://v2.tauri.app/security/capabilities/
- https://v2.tauri.app/develop/calling-rust/
- https://v2.tauri.app/plugin/updater/
