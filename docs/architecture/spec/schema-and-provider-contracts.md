# Schema and Provider Contracts

Canonical contracts are defined in `packages/review-types/src/index.ts`.

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

- `code`: `binary_missing|auth_missing|invalid_model_id|unsupported_reasoning_effort|provider_unavailable|configuration_error`
- `ok`: boolean
- `severity`: `info|warning|error`
- `detail`: human-readable reason
- `remediation`: optional action hint
