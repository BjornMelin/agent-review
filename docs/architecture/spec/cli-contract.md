# CLI Contract

CLI package: `@review-agent/review-cli`  
Binary name: `review-agent`

## Commands

## `review-agent run`

Runs a review and emits artifacts. Without `--detached`, execution stays local
inside the CLI process. With `--detached`, the command submits the request to the
hosted review service and emits the service `ReviewStartResponse` instead of
local artifacts.

### Target selection (exactly one required)

- `--uncommitted`
- `--base <branch>`
- `--commit <sha>` (optional `--title <title>`)
- `--prompt <instructions>`

### Execution and provider options

- `--provider <provider>`: `codex|gateway|openrouter` (default `codex`)
- `--execution <mode>`: `local-trusted|remote-sandbox` (default `local-trusted`)
- `remote-sandbox` requires `--detached` when sent to the HTTP service; inline
  service requests are rejected because sandbox execution is owned by
  `review-worker`.
- `remote-sandbox` currently supports only custom prompt targets over the
  service API. Git-backed targets require sandbox source binding first.
- `--model <modelId>`: provider-specific model string
- `--reasoning-effort <effort>`: `minimal|low|medium|high|xhigh`
- `--detached`: submit detached execution to the review service

### Diff filtering and limits

- `--include-path <glob...>`
- `--exclude-path <glob...>`
- `--max-files <n>`
- `--max-diff-bytes <n>`
- `--cwd <path>`

### Output

- `--format <format...>`: `sarif|json|markdown` (default all three)
- `--output <path>`: output file path or `-` for stdout (default `-`)
- `--severity-threshold <threshold>`: `p0|p1|p2|p3`
- `--quiet`: suppress progress logging
- `--convex-mirror`: enable optional mirror write bridge

### Hosted service options

When `--detached` is set, `run` accepts the same hosted service and repository
options as `submit`.

## `review-agent submit`

Submits a detached review to the hosted service. The command accepts the same
target, provider/model, filtering, `--max-files`, `--max-diff-bytes`, format,
and cwd options as `run`, plus the hosted service and repository options below.
It sends
`ReviewStartRequestSchema` with `delivery=detached` and `request.detached=true`
to `POST /v1/review/start`.

Service configuration:

- `--service-url <url>`: service base URL. Defaults to
  `REVIEW_AGENT_SERVICE_URL`, then `REVIEW_SERVICE_URL`, then
  `http://localhost:3042`. Remote service URLs must use HTTPS; plaintext HTTP
  is accepted only for `localhost`, IPv4 loopback (`127.0.0.0/8`), or IPv6
  loopback (`::1`). Service URLs must not include query strings, fragments, or
  embedded credentials.
- `--service-token <token>`: bearer token. Defaults to
  `REVIEW_AGENT_SERVICE_TOKEN`, then `REVIEW_SERVICE_TOKEN`.

One-shot hosted service requests (`submit`, `status`, `artifact`, `cancel`,
`publish`, and `run --detached`) enforce a 30-second timeout across response
headers and response body reads. Timeouts exit `4`.

Repository selection:

- `--repo <owner/name>`: GitHub repository. Defaults to `GITHUB_REPOSITORY`.
- `--repository-id <id>`: GitHub repository numeric ID. Defaults to
  `GITHUB_REPOSITORY_ID`.
- `--installation-id <id>`: GitHub App installation numeric ID. Defaults to
  `REVIEW_AGENT_GITHUB_INSTALLATION_ID`.
- `--pull-request <number>`: GitHub pull request target.
- `--ref <ref>`: GitHub ref target.
- `--commit-sha <sha>`: GitHub commit target.

Repository target flags must specify at most one of `--pull-request`, `--ref`,
or `--commit-sha`, matching `ReviewRepositorySelectionSchema`.

Publishable GitHub reviews must be commit-backed. Use `--commit <sha>` plus
repository/PR context when the run will later be sent through `publish`; custom
prompt targets can still be submitted and watched, but they do not carry the
commit metadata required for GitHub Checks, SARIF, and PR comments.

Output:

- `--output <path>` writes the formatted `ReviewStartResponse` JSON and defaults
  to stdout.

Hosted `cwd` remains part of the shared `ReviewRequest` contract. It is request
context only: the service must validate it against configured hosted repository
roots and the authenticated repository before execution.

## `review-agent status <reviewId>`

Fetches hosted review status from `GET /v1/review/:reviewId`, parses
`ReviewStatusResponseSchema`, and emits formatted JSON.

Options:

- `--service-url <url>`
- `--service-token <token>`
- `--output <path>`: output file path or `-` for stdout (default `-`)

The command exits `4` when the fetched run status is `failed` or `cancelled`;
HTTP/auth/schema failures use the operational exit-code mapping below.

## `review-agent watch <reviewId>`

Streams hosted review lifecycle events from `GET /v1/review/:reviewId/events`
as one JSON `LifecycleEvent` per stdout line. Keepalive frames are suppressed.
The command exits after a terminal lifecycle event, but successful streams keep
draining immediately emitted post-completion `artifactReady` events before
returning:

- `exitedReviewMode`: exit `0`
- `failed` or `cancelled`: exit `4`

If the SSE connection ends before a terminal lifecycle event, the command exits
`4` so CI does not treat a truncated stream as a completed review.
The response must advertise `Content-Type: text/event-stream`; missing or
non-SSE content types are rejected before event parsing and exit `4`.

Options:

- `--service-url <url>`
- `--service-token <token>`
- `--after-event-id <eventId>`: resume after a previously observed event ID
- `--limit <n>`: replay limit before live streaming

## `review-agent artifact <reviewId> <format>`

Fetches a completed hosted review artifact from
`GET /v1/review/:reviewId/artifacts/:format` and writes the raw artifact body
byte-for-byte without appending a newline.

Options:

- `--service-url <url>`
- `--service-token <token>`
- `--output <path>`: output file path or `-` for stdout (default `-`)

`<format>` is validated with `OutputFormatSchema` (`sarif|json|markdown`).

## `review-agent cancel <reviewId>`

Attempts to cancel a hosted detached review through
`POST /v1/review/:reviewId/cancel`, parses `ReviewCancelResponseSchema`, and
emits formatted JSON. Successful `200` or `202` responses exit `0`; service
conflicts and other HTTP failures use the operational exit-code mapping below.

Options:

- `--service-url <url>`
- `--service-token <token>`
- `--output <path>`: output file path or `-` for stdout (default `-`)

## `review-agent publish <reviewId>`

Publishes a completed hosted review to GitHub through
`POST /v1/review/:reviewId/publish`, parses `ReviewPublishResponseSchema`, and
emits formatted JSON.

Options:

- `--service-url <url>`
- `--service-token <token>`
- `--output <path>`: output file path or `-` for stdout (default `-`)

The command exits `0` for `published` or `skipped`; `partial` and `failed`
publication responses exit `4`.

## `review-agent models`

Prints provider-registry model presets, including default route markers and
capability policy.

## `review-agent doctor`

Checks provider wiring presence and exits:

- `0` when required providers are present
- `2` when checks fail for configuration/usage reasons
- `3` when checks fail for provider/auth readiness reasons

Options:

- `--provider <provider>`: `codex|gateway|openrouter|all` (default `all`)
- `--json`: emit machine-readable diagnostics payload

## `review-agent completion <shell>`

Prints shell completion script for:

- `bash`
- `zsh`
- `fish`

## Provider/Model Resolution Rules

- `--provider codex` maps to `provider=codexDelegate`.
- `--provider gateway` maps to `provider=openaiCompatible` and uses
  `gateway:openai/gpt-5` when `--model` is omitted.
- `--provider openrouter` maps to `provider=openaiCompatible` and uses
  `openrouter:openai/gpt-5` when `--model` is omitted.
- Unprefixed OpenAI-compatible model IDs are prefixed with the selected route.
  For example, `--provider gateway --model openai/gpt-5` becomes
  `gateway:openai/gpt-5`.
- A routed model prefix must match the selected route. For example,
  `--provider gateway --model openrouter:openai/gpt-5` fails as usage error.
- `packages/review-provider-registry` is the only package that may own provider
  construction, CLI route normalization, default model IDs, model catalog
  presets, and route-specific doctor filtering.

## Exit Codes

### Review result-driven

- `0`: no findings crossing configured threshold (or no findings when threshold absent)
- `1`: findings exist (or exceed threshold)

### Operational failures

- `2`: usage/target/schema/format failures
- `3`: auth/token/api-key failures
- `4`: sandbox/runtime/provider/other execution failures
- Hosted service HTTP mapping:
  - `401`/`403` -> `3`
  - `400`/`404`/`409`/`413` -> `2`
  - network failures, one-shot request timeouts, invalid service JSON/SSE
    payloads, non-SSE `watch` responses, `429`, and `5xx` -> `4`

## Output Semantics

- Single format requested: raw artifact string is emitted.
- Multiple formats requested: JSON object keyed by format (`sarif|json|markdown`) is emitted.
- Service command JSON responses are formatted JSON except `watch`, which emits
  JSON lines, and `artifact`, which emits the raw artifact body.
- Service command error messages redact the resolved bearer token whether it
  came from a flag or environment variable before writing to stderr.
