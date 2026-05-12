# Schema and Provider Contracts

Canonical contracts are defined in `packages/review-types/src/index.ts`.

Generated JSON Schema artifacts are committed under
`packages/review-types/generated/json-schema/`. The manifest in that directory
is generated from `buildJsonSchemaSet()` and tests compare every generated file
back to the live Zod schemas. Future Rust helpers must consume those generated
artifacts rather than hand-maintaining duplicate DTOs. Schema generation uses
Zod input mode so defaulted boundary fields remain optional in JSON Schema.

`crates/review-contracts` is the Rust parity crate. Its build script consumes
the committed schema manifest, injects deterministic Rust type titles, and
generates DTOs with `typify`. The generator normalizes value-level validation
keywords that Rust DTOs do not own, such as string lengths and numeric bounds;
Zod remains the canonical runtime validation owner. The crate exposes parser
helpers for Rust consumers that validate untrusted JSON against the committed
JSON Schema, apply explicit Rust guards for known Zod refinements that draft-07
JSON Schema cannot encode, and only then deserialize into generated DTOs.
Downstream Rust helpers can compile against those canonical JSON Schema shapes,
but they must not define hand-written request, result, lifecycle, provider,
sandbox, or service DTO structs.

Rust contract gates are part of root validation:

- `cargo fmt --all -- --check`
- `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`
- `cargo test --workspace --all-targets --all-features --locked`

`pnpm check` runs the TypeScript gates and then `pnpm rust:check`, so CI catches
contract generation drift before Rust helper behavior can ship.

## CommandRun Contracts

`CommandRunInputSchema` and `CommandRunOutputSchema` define the TypeScript-owned
contract for bounded local command execution through `packages/review-runner`
and `crates/review-runner`.

`CommandRunInput` includes:

- optional `commandId`
- `cmd`, `args`, and `cwd`
- optional `env` and `stdin`
- optional `timeoutMs`, `cancelAfterMs`, `maxStdoutBytes`, and
  `maxStderrBytes`
- optional `maxFileBytes` for each requested file capture
- optional `maxTotalFileBytes` for aggregate requested-file capture
- optional `tempDirPrefix`
- caller-declared `readFiles` capped at 16 entries

When `tempDirPrefix` is supplied, command args/env/cwd/read-file paths may use
`{tempDir}` as a placeholder, and the runner also injects
`REVIEW_RUNNER_TEMP_DIR`.

`CommandRunOutput` includes:

- command identity, redacted cmd/args, cwd, status, optional exit code
- redacted stdout/stderr plus truncation booleans and output byte count
- bounded requested-file content with per-file truncation booleans and an
  aggregate file-capture budget
- redaction counters compatible with sandbox audit counters
- lifecycle-style command events
- caller-requested file contents after redaction

Statuses are `completed`, `failedToStart`, `outputLimitExceeded`, `timedOut`,
and `cancelled`. Command events include `started`, `failedToStart`,
`stdoutLimitExceeded`, `stderrLimitExceeded`, `timedOut`, `cancelled`,
`exited`, `tempFileRead`, `fileLimitExceeded`, `tempDirCleaned`, and
`tempDirCleanupFailed`.

The Rust runner clears the inherited process environment before spawning a
child. Callers must pass an explicit env allowlist for command resolution and
provider auth. The Codex provider passes only path/home/config/auth material
needed by the Codex CLI, not the service process environment.
The Node adapter also starts the Rust helper with a filtered helper environment
and uses graceful termination before hard-kill fallback so the helper can cancel
and reap delegated process groups.
Package-local helper tests force a fresh Rust helper build so ignored `dist/bin`
artifacts cannot hide stale native code.

Byte limits apply to the public redacted UTF-8 output as well as the raw capture
boundary. Invalid UTF-8 is converted with replacement characters and then
trimmed on character boundaries so `outputBytes` cannot exceed the configured
stream/file caps.
Requested file captures reject non-regular paths before opening them, preventing
FIFOs or other special files from blocking capture after the delegated command
exits.

## ReviewRequest

Required fields:

- `cwd: string`
- `target: ReviewTarget`
- `provider: 'codexDelegate' | 'openaiCompatible'`
- `outputFormats: ('sarif' | 'json' | 'markdown')[]`

Optional fields:

- `executionMode: 'localTrusted' | 'remoteSandbox'` (default `localTrusted`)
- `model: string`
- `reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'`
- `includePaths: string[]`
- `excludePaths: string[]`
- `maxFiles: number`
- `maxDiffBytes: number`
- `severityThreshold: 'p0' | 'p1' | 'p2' | 'p3'`
- `detached: boolean`

`ReviewTarget` variants:

- `{ type: 'uncommittedChanges' }`
- `{ type: 'baseBranch', branch: string }`
- `{ type: 'commit', sha: string, title?: string }`
- `{ type: 'custom', instructions: string }`

## ReviewResult

- `findings: ReviewFinding[]`
- `overallCorrectness: 'patch is correct' | 'patch is incorrect' | 'unknown'`
- `overallExplanation: string`
- `overallConfidenceScore: number (0..1)`
- `metadata`:
  - `provider`
  - `modelResolved`
  - `executionMode`
  - `promptPack`
  - `gitContext` (`mode`, optional refs/shas)

`ReviewFinding` requires:

- `title`
- `body`
- optional `priority` (`0..3`)
- `confidenceScore` (`0..1`)
- `codeLocation.absoluteFilePath`
- `codeLocation.lineRange.start/end`
- `fingerprint`

## Raw Model Output Contract

Providers are expected to return model output compatible with `RawModelOutputSchema`:

- snake_case field naming
- `overall_correctness` must be one of:
  - `patch is correct`
  - `patch is incorrect`

If raw payload fails schema validation, core attempts JSON extraction from text and otherwise falls back to an `unknown` overall correctness result with empty findings.

## LifecycleEvent Contract

Event variants:

- `enteredReviewMode`
- `progress`
- `exitedReviewMode`
- `artifactReady`
- `failed`
- `cancelled`

Each event includes `meta` with:

- `eventId`
- `timestampMs`
- `correlation`:
  - `reviewId` (required)
  - `workflowRunId` (optional)
  - `sandboxId` (optional)
  - `commandId` (optional)

Used by CLI logging and service SSE streaming.

## Service API DTO Contracts

The review service uses `review-types` for request parsing and response DTOs.

- `ReviewStartRequestSchema`: wraps `ReviewRequest` with `delivery`
  (`inline|detached`, default `inline`).
- `ReviewStartResponseSchema`: start response with `reviewId`, run `status`,
  optional `detachedRunId`, and optional `result`.
- `ReviewStatusResponseSchema`: status response with timestamps, optional
  `error`, optional `result`, and optional durable publication records.
- `ReviewCancelResponseSchema`: cancel response with `reviewId`, run `status`,
  and optional `cancelled=false` for conflict responses.
- `ReviewPublicationRecordSchema`: durable per-channel publication state for
  outbound GitHub side effects.
- `ReviewPublishResponseSchema`: publish response with aggregate status and
  per-channel publication records.
- `ReviewErrorResponseSchema`: canonical `{ error }` response body.

`ReviewRunStatusSchema` is the single run-status owner:

- `queued`
- `running`
- `completed`
- `failed`
- `cancelled`

Artifact route parsing uses `OutputFormatSchema`. Content types are centralized
in `ARTIFACT_CONTENT_TYPES`.

`ReviewRequestSchema` also owns security-oriented input constraints shared by
CLI, service, core, and Rust contract validation:

- bounded `cwd`, custom instructions, commit titles, model IDs, branch refs,
  path filters, `maxFiles`, `maxDiffBytes`, and output format counts.
- branch refs reject revision expressions and Git/pathspec control syntax.
- commit targets must be object IDs; the git collector verifies object IDs
  resolve to commits before running `git show`.
- include/exclude path filters are repository-relative and reject absolute
  paths, `..` segments, negation syntax, and Git pathspec magic.
- `withReviewRequestSecurityDefaults()` fills bounded diff defaults when a
  caller omits `maxFiles` or `maxDiffBytes`, and clamps explicit values to the
  resolved service/core ceilings.
- `resolveReviewSecurityLimits()` accepts stricter runtime overrides, ignores
  non-positive values, and never allows configuration to widen the compiled
  shared defaults.

`redactSensitiveText()`, `redactLifecycleEvent()`, and
`redactReviewResult()` are the canonical redaction helpers for provider output,
command telemetry, service logs, lifecycle events, generated artifacts, and
durably persisted completed run payloads.

## Durable Store DTO and Database Contracts

The service durable store uses `review-types` DTOs at route boundaries and a
Drizzle/Postgres schema in `apps/review-service/src/storage/schema.ts` for
queryable persistence:

- `ReviewRunStoreRecordSchema`: run metadata keyed by `reviewId` and `runId`
  with status, request, optional authorization snapshot, timestamps, optional
  workflow/sandbox IDs, and optional terminal error.
- `ReviewRepositorySelectionSchema`: GitHub repository selected by a hosted
  start request.
- `ReviewRunAuthorizationSchema`: persisted principal, GitHub installation,
  repository, scopes, actor, request hash, and authorization timestamp.
- `ReviewEventStoreRecordSchema`: lifecycle event persistence with review ID,
  event ID, sequence number, event payload, and creation timestamp.
- `ReviewArtifactStoreRecordSchema`: artifact metadata with format, content
  type, byte length, checksum, storage key, and creation timestamp.
- `ReviewArtifactMetadataSchema`: service-facing artifact metadata shape.
- `ReviewEventCursorSchema`: event replay cursor with bounded `limit` default.
- `SandboxAuditSchema`: sandbox policy, budget consumption, redaction counters,
  and per-command audit records.
- `ReviewResultSchema.metadata.sandboxId`: optional sandbox identifier surfaced
  for completed remote sandbox runs.

The initial service database migration creates:

- `review_runs`: canonical run status, request, summary, result, workflow and
  sandbox IDs, retention, and deletion markers.
- `review_events`: lifecycle events keyed by `(review_id, sequence)` with a
  unique event ID.
- `review_artifacts`: artifact metadata, checksum, storage key, content type,
  byte length, and current artifact content.
- `review_status_transitions`: append-only status transition audit rows.

The GitHub authorization migration adds:

- `review_runs.authorization` and denormalized actor/repository/request-hash
  columns for object-level route authorization.
- `github_users`, `github_installations`, `github_repositories`, and
  `github_repository_permissions` for GitHub identity and repository permission
  snapshots.
- `service_tokens` for HMAC-hashed, repository-scoped automation tokens.
- `auth_audit_events` for append-only authn/authz/token-use audit rows.

Endpoint payloads continue to be shaped by `review-types`. Run, event,
artifact, and status-transition rows are implementation details behind
`ReviewStoreAdapter`; GitHub identity, scoped service token, and auth audit rows
are implementation details behind `ReviewAuthStoreAdapter`.

## Provider Interface Contract

Each provider implements:

- `id`
- `capabilities()`
- `run(input: ReviewProviderRunInput)`

`ReviewProviderRunInput` contains:

- parsed request
- resolved prompt
- rubric prompt
- normalized diff chunks

`run` returns:

- `raw` (provider-native output)
- `text` (string representation)
- optional `commandRun` when a provider invokes an external local command

If a provider command fails after producing `CommandRunOutput`, it should throw
`ReviewProviderCommandRunError`. Core emits command-run progress correlation
from that error before rethrowing, so timeout, cancellation, nonzero exit, and
output-limit telemetry is not lost on failure paths. Core emits the command
summary and each structured command event as correlated lifecycle progress so
event-store consumers can inspect the detailed command timeline.

Optional provider diagnostics hooks:

- `validateRequest(input)` for deterministic preflight validation
- `doctor()` for runtime/provider/auth diagnostics

## Provider Registry Contract

`packages/review-provider-registry` is the canonical owner for provider
construction and model policy. CLI, service, and worker entrypoints consume
`createReviewProviders()` instead of constructing providers directly.

The registry owns:

- route normalization for CLI providers (`codex`, `gateway`, `openrouter`)
- default OpenAI-compatible model IDs
- model catalog presets and capability policy
- provider doctor execution and route-specific doctor filtering

OpenAI-compatible provider implementations require a routed model ID from the
request or a registry-supplied `defaultModelId`. They do not own fallback model
defaults.

## Provider Implementations

### Codex Delegate Provider

- Invokes external `codex` binary (`CODEX_BIN` override supported).
- Uses `@review-agent/review-runner` to invoke `codex review` with
  target-derived args, process-group timeout enforcement, temporary last-message
  capture, redaction, and cleanup.
- Returns parsed JSON when possible; otherwise text fallback.

### OpenAI-Compatible Provider

- Supports model IDs in form `provider:model`.
- Accepted provider prefixes:
  - `gateway`
  - `openrouter`
- Uses AI SDK structured output (`Output.object`) with `RawModelOutputSchema`.
- Uses AI SDK Gateway `createGateway` for `gateway:*` model routing.
- Environment variables:
  - `AI_GATEWAY_API_KEY`
  - `OPENROUTER_API_KEY`

## Provider Diagnostic Contract

Provider diagnostics use stable shape:

- `code`: `binary_missing|auth_missing|auth_available|invalid_model_id|unsupported_reasoning_effort|provider_unavailable|configuration_error`
- `ok`: boolean
- `severity`: `info|warning|error`
- `scope`: optional route/provider scope such as `gateway` or `openrouter`
- `detail`: human-readable reason
- `remediation`: optional action hint

Doctor check names include diagnostic scope when present, for example
`provider.openaiCompatible.gateway.auth_missing`.
