# Review Agent Platform

Codex-grade review agent platform implemented as a pnpm/Turborepo monorepo with
a small Rust helper workspace for generated contract parity, production diff
indexing, and bounded process-group command execution.

## What It Does

The platform reviews code changes from git context and produces structured findings in multiple artifact formats.

- CLI entrypoint for direct usage (`review-agent`)
- HTTP service for inline or detached review execution
- GitHub publication path for Checks, SARIF upload, and idempotent PR comments
- Detached worker path with Workflow API orchestration and durable service state
- Review Room web app for hosted run history, live status, findings, artifacts,
  finding triage, publish preview/evidence, and publish/cancel controls
- Provider registry for Codex delegate and OpenAI-compatible model policy
- Durable service storage with Drizzle/Postgres when a database URL is configured
- Detached remote sandbox policy runner with Vercel Sandbox audit metadata
- Optional Convex metadata mirroring

## Monorepo Layout

```text
apps/
  review-cli/
  review-service/
  review-web/
  review-worker/
packages/
  review-convex-bridge/
  review-core/
  review-evals/
  review-git/
  review-prompts/
  review-provider-codex/
  review-provider-openai/
  review-provider-registry/
  review-runner/
  review-reporters/
  review-sandbox-vercel/
  review-types/
crates/
  review-contracts/
  review-git-diff/
docs/
  architecture/
```

## Prerequisites

- Node.js 24.x
- pnpm 11.0.9
- Rust stable with `rustfmt` and `clippy`
- git (required for diff collection)
- Optional: `codex` CLI for `codexDelegate` provider

## Quickstart

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

## Local Usage

### CLI

Run the CLI in dev mode:

```bash
pnpm --filter @review-agent/review-cli dev run --uncommitted --provider codex --format json
```

List provider-registry model presets:

```bash
pnpm --filter @review-agent/review-cli dev models
pnpm --filter @review-agent/review-cli dev models --json
```

The default output is human-readable. Use `--json` for machine-readable catalog
data. The model catalog is an allowlist. It includes the default marker,
fallback order, maximum input characters, maximum output tokens, per-attempt
timeout, attempt budget, retention class, ZDR requirement, and prompt-training
policy for each `gateway:*` and `openrouter:*` model.

Run provider checks:

```bash
pnpm --filter @review-agent/review-cli dev doctor
```

Submit and watch a hosted detached review:

```bash
export REVIEW_AGENT_SERVICE_URL=http://localhost:3042
export REVIEW_AGENT_SERVICE_TOKEN=rat_<tokenId>_<secret>

pnpm --filter @review-agent/review-cli dev submit \
  --commit "$GITHUB_SHA" \
  --provider gateway \
  --format json \
  --repo "$GITHUB_REPOSITORY" \
  --pull-request "$PR_NUMBER"

pnpm --filter @review-agent/review-cli dev list --status failed --repo "$GITHUB_REPOSITORY"
pnpm --filter @review-agent/review-cli dev watch <reviewId>
pnpm --filter @review-agent/review-cli dev status <reviewId>
pnpm --filter @review-agent/review-cli dev artifact <reviewId> markdown --output review.md
pnpm --filter @review-agent/review-cli dev cancel <reviewId>
pnpm --filter @review-agent/review-cli dev publish <reviewId>
```

### Service

Start service (default `PORT=3042`):

```bash
pnpm --filter @review-agent/review-service dev
```

Service endpoints are documented in [docs/architecture/spec/review-service-api.md](docs/architecture/spec/review-service-api.md).
When `DATABASE_URL` or `POSTGRES_URL` is set, run the service database migration
before startup; startup does not apply migrations automatically.

```bash
pnpm --filter @review-agent/review-service db:migrate
```

### Review Room

Run the Next.js Review Room against a local or hosted review service:

```bash
export REVIEW_WEB_SERVICE_URL=http://localhost:3042
export REVIEW_WEB_SERVICE_TOKEN=rat_<tokenId>_<secret>

pnpm --filter @review-agent/review-web dev
```

The web app reads `GET /v1/review`, status, artifact, event, finding triage,
publish preview, publish, and cancel service endpoints through server-side data
loading and token-safe route handlers. Deployment notes are in
[docs/deployment/review-web.md](docs/deployment/review-web.md).

## Environment Variables

| Variable | Used By | Purpose |
| --- | --- | --- |
| `PORT` | `apps/review-service` | Service bind port (default `3042`) |
| `DATABASE_URL` / `POSTGRES_URL` | `apps/review-service` | Enables durable Drizzle/Postgres review run, event, and artifact storage |
| `REVIEW_SERVICE_STORAGE=memory` | `apps/review-service` | Explicitly allows volatile in-memory service storage when no database URL is set |
| `REVIEW_SERVICE_AUTH_MODE=required\|disabled` | `apps/review-service` | Enables hosted auth; defaults to `required`; `disabled` is rejected in production |
| `REVIEW_SERVICE_TOKEN_PEPPER` | `apps/review-service` | Required when hosted auth is enabled; HMAC pepper for scoped service-token verifier hashes |
| `REVIEW_SERVICE_ALLOWED_CWD_ROOTS` | `apps/review-service` | Comma-separated host root allowlist for review working directories |
| `REVIEW_SERVICE_HOSTED_REPOSITORY_ROOTS` | `apps/review-service` | Comma-separated checkout parent roots; defaults to `REVIEW_SERVICE_ALLOWED_CWD_ROOTS`; authenticated starts must run under `<root>/<owner>/<repo>` |
| `GITHUB_API_BASE_URL` | `apps/review-service` | Optional GitHub API base URL override for Enterprise Server testing |
| `GITHUB_APP_ID` | `apps/review-service` | Enables GitHub publication by identifying the GitHub App used to mint installation-scoped write tokens |
| `GITHUB_APP_PRIVATE_KEY` | `apps/review-service` | GitHub App private key used for publication tokens; escaped `\n` sequences are normalized at startup |
| `REVIEW_AGENT_SERVICE_URL` / `REVIEW_SERVICE_URL` | `apps/review-cli` | Hosted review service URL for `submit`, `list`, `status`, `watch`, `artifact`, `cancel`, `publish`, and `run --detached` (default `http://localhost:3042`) |
| `REVIEW_AGENT_SERVICE_TOKEN` / `REVIEW_SERVICE_TOKEN` | `apps/review-cli` | Hosted review service bearer token for service commands; prefer env over `--service-token` in CI |
| `REVIEW_WEB_SERVICE_URL` / `REVIEW_AGENT_SERVICE_URL` / `REVIEW_SERVICE_URL` | `apps/review-web` | Review Room service URL; defaults to `http://localhost:3042` for local development |
| `REVIEW_WEB_SERVICE_TOKEN` / `REVIEW_AGENT_SERVICE_TOKEN` / `REVIEW_SERVICE_TOKEN` | `apps/review-web` | Server-only bearer token used by Review Room route handlers; never expose it through `NEXT_PUBLIC_*` |
| `REVIEW_WEB_ACCESS_TOKEN` | `apps/review-web` | Required in production/preview to gate browser access before any server-side service token is used; accepted through Basic auth, bearer auth, or `x-review-room-access-token` |
| `GITHUB_REPOSITORY` / `GITHUB_REPOSITORY_ID` | `apps/review-cli` | Optional GitHub repository defaults attached to hosted start requests (`submit` and `run --detached`); `GITHUB_REPOSITORY` also defaults `review-agent list --repo` |
| `REVIEW_AGENT_GITHUB_INSTALLATION_ID` | `apps/review-cli` | Optional GitHub App installation ID attached to hosted start requests (`submit` and `run --detached`) |
| `CODEX_BIN` | `packages/review-provider-codex` via provider registry | Override codex executable path (default `codex`) |
| `AI_GATEWAY_API_KEY` | `packages/review-provider-openai` via provider registry | API key for gateway models |
| `OPENROUTER_API_KEY` | `packages/review-provider-openai` via provider registry | API key for OpenRouter |
| `CONVEX_URL` | `packages/review-convex-bridge` | Enables optional metadata mirror mutation |
| `REVIEW_AGENT_DIFF_INDEX_BIN` | `packages/review-git` | Overrides the Rust diff-index helper binary path; package builds otherwise resolve `dist/bin/review-git-diff` |
| `REVIEW_AGENT_DIFF_INDEX_ALLOW_BUILD=1` | `packages/review-git` | Enables development-only Cargo build fallback when the helper binary is missing |
| `REVIEW_AGENT_DIFF_INDEX_BUILD_TIMEOUT_MS` | `packages/review-git` | Overrides the development-only Rust helper build timeout (default `120000`) |
| `REVIEW_AGENT_DIFF_INDEX_MAX_STDOUT_BYTES` / `REVIEW_AGENT_DIFF_INDEX_MAX_STDERR_BYTES` | `packages/review-git` | Caps Rust helper output collected by the Node adapter |
| `REVIEW_AGENT_DIFF_INDEX_TIMEOUT_MS` | `packages/review-git` | Overrides the Rust diff-index helper execution timeout (default `30000`) |
| `REVIEW_AGENT_RUNNER_BIN` | `packages/review-runner` | Overrides the Rust process runner helper binary path; package builds otherwise resolve `dist/bin/review-runner` |
| `REVIEW_AGENT_RUNNER_ALLOW_BUILD=1` | `packages/review-runner` | Enables development-only Cargo build fallback when the runner helper binary is missing |
| `REVIEW_AGENT_RUNNER_BUILD_TIMEOUT_MS` | `packages/review-runner` | Overrides the development-only Rust runner build timeout (default `120000`) |
| `REVIEW_AGENT_RUNNER_HELPER_TIMEOUT_MS` | `packages/review-runner` | Minimum timeout for the helper process wrapper; command timeout plus padding can extend this |
| `REVIEW_AGENT_RUNNER_HELPER_TIMEOUT_PADDING_MS` | `packages/review-runner` | Extra helper-process time added beyond each requested command timeout (default `10000`) |
| `REVIEW_AGENT_RUNNER_HELPER_MAX_STDOUT_BYTES` / `REVIEW_AGENT_RUNNER_HELPER_MAX_STDERR_BYTES` | `packages/review-runner` | Caps helper stdout/stderr collected by the Node adapter |
| `REVIEW_AGENT_STRICT_PERF=1` | `packages/review-git` tests | Enables strict parser/diff performance thresholds |

The runner adapter starts the Rust helper with a filtered environment. Delegated
commands still receive only the explicit env allowlist supplied in
`CommandRunInput`.

## Build and CI

Root scripts:

- `pnpm build`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm rust:check`
- `pnpm git:benchmark`
- `pnpm check`
- `bash scripts/repro-check.sh`

CI workflow: `.github/workflows/ci.yml` installs Node/pnpm and stable Rust, then
runs install, format, lint, typecheck, test, Rust helper gates, and build.

## Documentation

- Docs index: [docs/README.md](docs/README.md)
- Product requirements: [docs/PRD.md](docs/PRD.md)
- Review Room deployment: [docs/deployment/review-web.md](docs/deployment/review-web.md)
- Architecture requirements: [docs/architecture/requirements.md](docs/architecture/requirements.md)
- Architecture specs: [docs/architecture/spec/](docs/architecture/spec/)
- Architecture decisions: [docs/architecture/adr/](docs/architecture/adr/)
