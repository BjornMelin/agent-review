# Schema and Provider Contracts

Canonical contracts are defined in `packages/review-types/src/index.ts`.

Generated JSON Schema artifacts are committed under
`packages/review-types/generated/json-schema/`. The manifest in that directory
is generated from `buildJsonSchemaSet()` and tests compare every generated file
back to the live Zod schemas. Future Rust helpers must consume those generated
artifacts rather than hand-maintaining duplicate DTOs. Schema generation uses
Zod input mode so defaulted boundary fields remain optional in JSON Schema.

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
  `error`, and optional `result`.
- `ReviewCancelResponseSchema`: cancel response with `reviewId`, run `status`,
  and optional `cancelled=false` for conflict responses.
- `ReviewErrorResponseSchema`: canonical `{ error }` response body.

`ReviewRunStatusSchema` is the single run-status owner:

- `queued`
- `running`
- `completed`
- `failed`
- `cancelled`

Artifact route parsing uses `OutputFormatSchema`. Content types are centralized
in `ARTIFACT_CONTENT_TYPES`.

## Durable Store DTO and Database Contracts

The service durable store uses `review-types` DTOs at route boundaries and a
Drizzle/Postgres schema in `apps/review-service/src/storage/schema.ts` for
queryable persistence:

- `ReviewRunStoreRecordSchema`: run metadata keyed by `reviewId` and `runId`
  with status, request, timestamps, optional workflow/sandbox IDs, and optional
  terminal error.
- `ReviewEventStoreRecordSchema`: lifecycle event persistence with review ID,
  event ID, sequence number, event payload, and creation timestamp.
- `ReviewArtifactStoreRecordSchema`: artifact metadata with format, content
  type, byte length, checksum, storage key, and creation timestamp.
- `ReviewArtifactMetadataSchema`: service-facing artifact metadata shape.
- `ReviewEventCursorSchema`: event replay cursor with bounded `limit` default.
- `SandboxAuditSchema`: sandbox policy, budget consumption, redaction counters,
  and per-command audit records.

The initial service database migration creates:

- `review_runs`: canonical run status, request, summary, result, workflow and
  sandbox IDs, retention, and deletion markers.
- `review_events`: lifecycle events keyed by `(review_id, sequence)` with a
  unique event ID.
- `review_artifacts`: artifact metadata, checksum, storage key, content type,
  byte length, and current artifact content.
- `review_status_transitions`: append-only status transition audit rows.

Endpoint payloads continue to be shaped by `review-types`; database rows are an
implementation detail behind `ReviewStoreAdapter`.

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
- Uses codex review command with target-derived args.
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
