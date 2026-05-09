# Review Agent Platform

Codex-grade review agent platform implemented as a pnpm/Turborepo monorepo.

## What It Does

The platform reviews code changes from git context and produces structured findings in multiple artifact formats.

- CLI entrypoint for direct usage (`review-agent`)
- HTTP service for inline or detached review execution
- Detached worker path with Workflow API support and local fallback
- Provider abstraction for Codex delegate and OpenAI-compatible models
- Optional sandbox policy checks and optional Convex metadata mirroring

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
  review-reporters/
  review-sandbox-vercel/
  review-types/
docs/
  architecture/
```

## Prerequisites

- Node.js 24.x
- pnpm 11.0.9
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

List built-in static models:

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

## Environment Variables

| Variable | Used By | Purpose |
| --- | --- | --- |
| `PORT` | `apps/review-service` | Service bind port (default `3042`) |
| `CODEX_BIN` | `packages/review-provider-codex` | Override codex executable path (default `codex`) |
| `AI_GATEWAY_API_KEY` | `packages/review-provider-openai` | API key for gateway models |
| `OPENROUTER_API_KEY` | `packages/review-provider-openai` | API key for OpenRouter |
| `CONVEX_URL` | `packages/review-convex-bridge` | Enables optional metadata mirror mutation |

## Build and CI

Root scripts:

- `pnpm build`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm check`
- `bash scripts/repro-check.sh`

CI workflow: `.github/workflows/ci.yml` runs install, format, lint, typecheck, test, and build.

## Documentation

- Docs index: [docs/README.md](docs/README.md)
- Product requirements: [docs/PRD.md](docs/PRD.md)
- Architecture requirements: [docs/architecture/requirements.md](docs/architecture/requirements.md)
- Architecture specs: [docs/architecture/spec/](docs/architecture/spec/)
- Architecture decisions: [docs/architecture/adr/](docs/architecture/adr/)
