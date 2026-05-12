# CI Hardening Runbook

This runbook defines the required CI lanes for every roadmap PR. The stable
branch-protection check proves TypeScript, Rust, generated contracts, and
dependency advisory posture. Vercel preview smoke adds deployment evidence when
Vercel emits a preview signal.

## Required GitHub Checks

The `CI` workflow exposes these named lanes:

| Check | Purpose | Primary command |
| --- | --- | --- |
| `Static checks` | Biome repository check plus package lint scripts. | `pnpm exec biome ci --error-on-warnings .` and `pnpm lint` |
| `Generated contracts` | Regenerate committed JSON Schema artifacts, fail on drift, then prove Rust DTO parity. | `pnpm ci:contracts` |
| `Rust gates` | Check formatting, clippy, and tests across the Cargo workspace. | `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`, `cargo test --workspace --all-targets --all-features --locked` |
| `Typecheck, tests, and builds` | Prove TypeScript contracts, Vitest suites, Rust diff/index benchmark, Review Room build, and workspace build. | `pnpm typecheck`, `pnpm test`, `pnpm git:benchmark`, `pnpm --filter @review-agent/review-web build`, `pnpm build` |
| `Dependency security audit` | Fail on high-severity production npm advisories and RustSec advisory warnings. | `pnpm ci:security` |
| `check` | Branch-protection aggregator requiring every lane above to succeed. | GitHub Actions `needs` result assertion |

`check` remains the stable branch-protection check name. Do not merge if any
upstream lane is skipped, cancelled, or failed.

All third-party workflow actions are pinned to full-length commit SHAs with the
reviewed tag noted in a YAML comment. Refresh pins only after inspecting the
upstream release and recording the reason in the PR.

`actions/checkout` uses `persist-credentials: false` in CI lanes so package
scripts cannot reuse the workflow token.

## Generated Contract Drift

`pnpm ci:contracts` runs `scripts/check-generated-contracts.sh`.

The script runs `pnpm --filter @review-agent/review-types generate:schemas`,
which may refresh ignored `dist/` build output before rewriting committed schema
artifacts. It fails if `packages/review-types/generated/json-schema/` differs
from the committed tree. It then runs
`cargo test -p review-agent-contracts --locked` so the Rust DTO generator proves
the committed schema manifest still compiles and parses representative payloads.

Before relying on a green PR, verify this gate fails when expected:

1. Temporarily edit any committed file under
   `packages/review-types/generated/json-schema/`.
2. Run `pnpm ci:contracts` and confirm it exits non-zero with a stale-artifact
   error.
3. Revert the temporary edit before committing.

For Rust gate verification, temporarily introduce a harmless local formatting or
test failure under `crates/`, run the matching Cargo command, and revert the
change before committing.

## Dependency Advisory Policy

`pnpm ci:security` runs `scripts/security-audit.sh`.

- npm advisories: `pnpm audit --audit-level high --prod`.
- Cargo advisories: `cargo audit --deny warnings`.

The Rust lane installs `cargo-audit` at the pinned script version when the
command is missing. Advisory ignores are not allowed inline in workflow YAML;
any accepted advisory exception must be documented with issue links, affected
packages, scope, and expiration.

## Vercel Preview Smoke

The `Vercel Preview` workflow runs on successful Vercel preview deployment
signals. It accepts the standard GitHub `deployment_status` event and the Vercel
recommended `repository_dispatch` event with type `vercel.deployment.success`.
It reads the deployed app from `deployment_status.environment_url` or
`client_payload.url`, not `target_url`.

The automated workflow is secret-free so it can run against PR preview
deployments without sending repository secrets to deployed code. It checks out
trusted scripts from `main` with `persist-credentials: false` and has
least-privilege `contents: read` and `deployments: read` permissions. It
performs two checks:

1. `node scripts/preview-smoke.mjs` fetches public `/api/health`, requiring the
   preview to have both server-side Review Room tokens configured, then verifies
   `/` fails closed without browser credentials.
2. `bash scripts/agent-browser-preview-smoke.sh` opens `/api/health` with
   `agent-browser` in secret-free mode and uploads a screenshot artifact. When
   `REVIEW_WEB_ACCESS_TOKEN` is explicitly provided for trusted manual dogfood,
   it opens `/` and verifies the protected page renders.

Manual trusted dogfood can opt into authenticated checks by exporting:

- `REVIEW_WEB_ACCESS_TOKEN`: access token accepted by Review Room in preview.
- `VERCEL_AUTOMATION_BYPASS_SECRET`: Vercel Deployment Protection bypass token
  used through the `x-vercel-protection-bypass` header.
- `agent-browser`: pinned in `pnpm-lock.yaml`; do not replace it with a runtime
  `npx` fetch in secret-bearing workflows.

The smoke scripts also work locally:

```bash
DEPLOYMENT_URL=https://<preview>.vercel.app \
node scripts/preview-smoke.mjs

DEPLOYMENT_URL=https://<preview>.vercel.app \
bash scripts/agent-browser-preview-smoke.sh
```

For a trusted deployment where sending credentials to the deployed app is
acceptable, add `REVIEW_WEB_ACCESS_TOKEN` to require authenticated page render.
Add `VERCEL_AUTOMATION_BYPASS_SECRET` only when Vercel Deployment Protection
blocks the preview before Review Room can serve `/api/health`.

When branch protection needs a hard preview gate, require the Vercel deployment
check plus this workflow after repository-dispatch delivery is configured.
Conditional `deployment_status` workflows alone are not sufficient as the only
required check because GitHub treats skipped jobs as successful.

## Flake and Failure Triage

Do not blindly retry failed checks.

1. Inspect the failed lane log and identify the failing command.
2. Reproduce locally with the exact script or a narrower package command.
3. Classify the failure as product regression, test defect, environment outage,
   or confirmed flaky infrastructure.
4. Fix product/test defects in the PR with focused tests.
5. Retry only failures classified as flaky or unrelated after recording the
   evidence in the PR.

Hosted review comments and CI failures are separate obligations: a green `check`
does not mean unresolved review threads are clean, and resolved review threads
do not replace required CI evidence.

## References

- GitHub Actions secure use:
  https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
- GitHub Actions permissions:
  https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#permissions
- Cargo clippy:
  https://doc.rust-lang.org/cargo/commands/cargo-clippy.html
- Playwright CI:
  https://playwright.dev/docs/ci
- Vercel automated and agent access:
  https://vercel.com/docs/deployment-protection/automated-agent-access
- Vercel Protection Bypass for Automation:
  https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation
