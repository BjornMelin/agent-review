# Review Agent Platform

Codex-grade review agent platform implemented as a pnpm/Turborepo monorepo with
a small Rust helper workspace for generated contract parity and gated helper
candidates.

## What It Does

The platform reviews code changes from git context and produces structured findings in multiple artifact formats.

- CLI entrypoint for direct usage (`review-agent`)
- HTTP service for inline or detached review execution
- Detached worker path with Workflow API orchestration and durable service state
- Provider registry for Codex delegate and OpenAI-compatible model policy
- Durable service storage with Drizzle/Postgres when a database URL is configured
- Detached remote sandbox policy runner with Vercel Sandbox audit metadata
- Optional Convex metadata mirroring

## Monorepo Layout

```text
apps/
  review-cli/
  review-service/
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
pnpm --filter @review-agent/review-cli dev -- run --uncommitted --provider codex --format json
```

List provider-registry model presets:

```bash
pnpm --filter @review-agent/review-cli dev -- models
```

Run provider checks:

```bash
pnpm --filter @review-agent/review-cli dev -- doctor
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

## Environment Variables

| Variable | Used By | Purpose |
| --- | --- | --- |
| `PORT` | `apps/review-service` | Service bind port (default `3042`) |
| `DATABASE_URL` / `POSTGRES_URL` | `apps/review-service` | Enables durable Drizzle/Postgres review run, event, and artifact storage |
| `REVIEW_SERVICE_STORAGE=memory` | `apps/review-service` | Explicitly allows volatile in-memory service storage when no database URL is set |
| `CODEX_BIN` | `packages/review-provider-codex` via provider registry | Override codex executable path (default `codex`) |
| `AI_GATEWAY_API_KEY` | `packages/review-provider-openai` via provider registry | API key for gateway models |
| `OPENROUTER_API_KEY` | `packages/review-provider-openai` via provider registry | API key for OpenRouter |
| `CONVEX_URL` | `packages/review-convex-bridge` | Enables optional metadata mirror mutation |
| `REVIEW_AGENT_STRICT_PERF=1` | `packages/review-git` tests | Enables strict parser/diff performance thresholds |
| `REVIEW_AGENT_RUST_DIFF_BENCH=1` | `packages/review-git` tests | Compares the TypeScript parser/index path with the Rust `review-git-diff` candidate |

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
- Architecture requirements: [docs/architecture/requirements.md](docs/architecture/requirements.md)
- Architecture specs: [docs/architecture/spec/](docs/architecture/spec/)
- Architecture decisions: [docs/architecture/adr/](docs/architecture/adr/)
