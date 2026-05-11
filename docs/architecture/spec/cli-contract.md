# CLI Contract

CLI package: `@review-agent/review-cli`  
Binary name: `review-agent`

## Commands

## `review-agent run`

Runs a review and emits artifacts.

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
- `--detached`: request detached execution mode in request payload

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

## Output Semantics

- Single format requested: raw artifact string is emitted.
- Multiple formats requested: JSON object keyed by format (`sarif|json|markdown`) is emitted.
