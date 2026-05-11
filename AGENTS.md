# AGENTS.md

Instructions for AI coding agents working with this codebase.

## Repository Architecture Snapshot

This repository is a TypeScript monorepo managed by pnpm workspaces and Turborepo.

- `apps/review-cli`: CLI entrypoint (`review-agent`) for local and CI usage.
- `apps/review-service`: HTTP service for inline and detached review orchestration.
- `apps/review-worker`: Detached execution adapter using Workflow API and
  durable service state.
- `packages/review-core`: Review orchestration, diff filtering, finding validation, artifact rendering.
- `packages/review-types`: Canonical Zod schemas and shared runtime/type contracts.
- `packages/review-git`: Git diff collection and changed-line indexing.
- `packages/review-prompts`: Prompt and rubric resolution.
- `packages/review-provider-codex`: Codex CLI delegate provider.
- `packages/review-provider-openai`: AI SDK gateway/openrouter provider.
- `packages/review-sandbox-vercel`: Sandbox policy and execution wrapper.
- `packages/review-reporters`: JSON/Markdown/SARIF rendering.
- `packages/review-convex-bridge`: Optional non-blocking metadata mirror.
- `packages/review-evals`: Exit-code oriented eval helpers.

## Verification Commands

Use root scripts unless a task is package-local:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm check` (runs lint + typecheck + test)

## Documentation Synchronization Contract

When implementation changes touch behavior, contracts, or architecture, update docs in the same change:

- Root overview and setup: `README.md`
- Docs index and navigation: `docs/README.md`
- Product framing: `docs/PRD.md`
- Requirements baseline: `docs/architecture/requirements.md`
- Detailed technical contracts: `docs/architecture/spec/*.md`
- Architecture decisions: `docs/architecture/adr/*.md`

Update documentation for any of the following:

- New/changed CLI commands, flags, defaults, or exit codes.
- New/changed HTTP endpoints, payloads, status values, or streaming events.
- New/changed schema fields/enums in `packages/review-types`.
- Provider behavior or environment-variable requirements.
- Sandbox policy/budget/network model changes.
- Detached execution semantics and fallback behavior.

When a change introduces a new architectural decision (not just implementation detail), add a new ADR and cross-link it from relevant spec docs.

<!-- opensrc:start -->

## Source Code Reference

Source code for dependencies is available in `opensrc/` for deeper understanding of implementation details.

See `opensrc/sources.json` for the list of available packages and their versions.

Use this source code when you need to understand how a package works internally, not just its types/interface.

### Fetching Additional Source Code

To fetch source code for a package or repository you need to understand, run:

```bash
npx opensrc <package>           # npm package (e.g., npx opensrc zod)
npx opensrc pypi:<package>      # Python package (e.g., npx opensrc pypi:requests)
npx opensrc crates:<package>    # Rust crate (e.g., npx opensrc crates:serde)
npx opensrc <owner>/<repo>      # GitHub repo (e.g., npx opensrc vercel/ai)
```

<!-- opensrc:end -->
