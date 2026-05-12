# Dependency Modernization Ledger - 2026-05

Tracking issue: https://github.com/BjornMelin/agent-review/issues/4

## Scope

This ledger records the May 2026 dependency modernization wave. It is historical
evidence, not the current package-policy source of truth. Current dependency
build-script policy lives in `pnpm-workspace.yaml`; current CI and advisory
policy lives in [CI Hardening Runbook](./ci-hardening.md).

This modernization moves the monorepo to the current compatible dependency
baseline, removes unused dependency edges, and aligns runtime/tooling contracts
with current upstream support:

- Node.js 24.x and pnpm 11.0.9 are the repo baseline.
- Biome config is migrated from v1.9 to v2.4.
- Hono, AI SDK, Vercel Sandbox, Convex, Zod, Vitest, Turbo, TypeScript, and
  direct runtime dependencies are upgraded to their current compatible versions.
- The detached worker uses `@workflow/core` directly instead of the broader
  `workflow` meta package, avoiding unused framework and CLI transitive
  dependencies.
- pnpm 11 build-script policy is explicit in `pnpm-workspace.yaml`.

## Research Sources

- Node.js release schedule: https://github.com/nodejs/Release
- pnpm releases: https://github.com/pnpm/pnpm/releases
- Biome v2 upgrade guide: https://biomejs.dev/guides/upgrade-to-biome-v2/
- AI SDK structured output and AI Gateway docs: https://ai-sdk.dev/
- Vercel Sandbox docs: https://vercel.com/docs/vercel-sandbox
- Hono Node.js docs: https://hono.dev/docs/getting-started/nodejs
- Vitest migration docs: https://vitest.dev/guide/migration
- Zod v4 changelog: https://zod.dev/v4/changelog

## Decisions

- `@types/node` is held on the latest Node 24 type line instead of Node 25.
  Node 24 is Active LTS while Node 25 is a short-lived Current release.
- `@workflow/core` replaces `workflow` because this repo only uses
  `start(...)` and `getRun(...)` from the runtime API. The removed meta package
  pulled unused framework adapters and CLI dependencies into the worker graph.
- pnpm overrides are limited to patched transitive versions needed to resolve
  advisories in `devalue`, `picomatch`, `postcss`, `undici`, and `vite`.
- At the time of the modernization PR, pnpm build-script policy allowed only
  the native/toolchain packages then present in the dependency graph:
  `@biomejs/biome`, `cbor-extract`, and `esbuild`. Current policy has since
  expanded for Review Room image/browser tooling and must be read from
  `pnpm-workspace.yaml`.

## Verification

- `CI=true corepack pnpm@11.0.9 install --frozen-lockfile`
- `corepack pnpm@11.0.9 check`
- `corepack pnpm@11.0.9 build`
- `corepack pnpm@11.0.9 audit --json`
- `corepack pnpm@11.0.9 dlx knip@latest --reporter compact`
- CLI smoke: `review-agent models`
- CLI smoke: `review-agent doctor --provider gateway --json`
- HTTP smoke: `GET /v1/review/missing-id`
- HTTP smoke: `POST /v1/review/start` with `executionMode=remoteSandbox`,
  detached delivery, and a custom target

At the time of this modernization PR, there was no rendered web frontend or
shadcn component surface in the repo, so browser visual verification was not
applicable to that modernization. Current Review Room UI changes require the
browser and preview smoke gates documented in
[Release Checklist](./release-checklist.md).
