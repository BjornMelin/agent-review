# Final Launch Signoff - 2026-05

Tracking issue: https://github.com/BjornMelin/agent-review/issues/35

## Scope

This signoff records the final release-hardening pass after the roadmap issues
for runtime, service, GitHub publication, Review Room, CI, native expansion
decisions, and documentation alignment merged.

The codebase is ready for a controlled internal launch when the external
production environment gates below are completed by an operator with the
required Vercel, GitHub App, provider, and database credentials. No additional
repository code changes are required for the local evidence captured in this
signoff; hosted CI evidence is captured on the release PR before merge.

## Fixed During Signoff

- The Codex delegate provider was still invoking a stale Codex CLI shape:
  `codex --output-last-message ... review ...`.
- Current Codex CLI exposes last-message capture on the non-interactive exec
  path: `codex exec -o <file> review ...`.
- `packages/review-provider-codex` now uses the current command shape and its
  contract test fails if the last-message output path is not passed.
- Custom Codex review instructions are now passed after an argv delimiter so
  prompt text such as `--ignore-rules` cannot be parsed as Codex CLI flags.
- Review Room now uses a deterministic Next.js build ID from
  `REVIEW_WEB_BUILD_ID`, `VERCEL_GIT_COMMIT_SHA`, `GITHUB_SHA`, or `local`, and
  the reproducibility gate includes `.next` build outputs while excluding only
  cache and trace diagnostics.

## Local Verification Evidence

Run from the repository root on 2026-05-12.

| Area | Command or evidence | Result |
| --- | --- | --- |
| Root check | `pnpm check` | Passed |
| Root build | `pnpm build` | Passed |
| Contract CI gate | `pnpm ci:contracts` | Passed |
| Security CI gate | `pnpm ci:security` | Passed |
| Reproducibility | `bash scripts/repro-check.sh` | Passed; build output hashes matched |
| Provider contract test | `pnpm --filter @review-agent/review-provider-codex test` | Passed, 6 tests |
| Provider typecheck | `pnpm --filter @review-agent/review-provider-codex typecheck` | Passed |
| Review service local read | `curl http://localhost:3042/v1/review` with `REVIEW_SERVICE_AUTH_MODE=disabled` | Returned `{\"runs\":[]}` |
| Hosted CLI list smoke | `REVIEW_AGENT_SERVICE_URL=http://localhost:3042 REVIEW_AGENT_SERVICE_TOKEN=local-smoke-token pnpm --filter @review-agent/review-cli dev list --limit 1 --output -` | Passed, returned empty run list |
| Provider doctor | `pnpm --filter @review-agent/review-cli dev doctor --provider all --json` | Codex delegate and AI Gateway auth available; OpenRouter missing |
| Codex delegate pre-review | `pnpm --filter @review-agent/review-cli dev run --cwd <repo-root> --uncommitted --provider codex --format json markdown --output /tmp/issue-35-uncommitted-review --exclude-path dogfood-output/** ...` | Initial run found the `.next` reproducibility gap; fixed. Final rerun exited nonzero with a verbose Codex transcript, so it is not counted as passing release evidence. |
| Specialized reviewer pass | Runtime, security, docs, and Vercel/deployment read-only reviewers | Runtime and Vercel reviewers reported no findings; security/docs findings were fixed in this branch. |
| Review Room desktop smoke | `agent-browser --session issue-35-desktop open http://localhost:3000` plus screenshot | Rendered Review Room empty state from local service |
| Review Room mobile smoke | `agent-browser --session issue-35-mobile set viewport 390 844` plus screenshot | Rendered Review Room empty state at mobile width |
| Browser console/errors | `agent-browser console` and `agent-browser errors` on desktop/mobile sessions | No page errors; only React DevTools and HMR dev messages |
| Browser vitals | `agent-browser vitals http://localhost:3000 --json` | TTFB 36.1ms, LCP 72ms, CLS 0, FCP 72ms, hydration 8ms |
| Preview smoke, fail closed | `DEPLOYMENT_URL=http://localhost:3000 PREVIEW_SMOKE_ALLOWED_HOSTS=localhost node scripts/preview-smoke.mjs` with local access/service token env on web server only | Passed |
| Preview smoke, authenticated | `DEPLOYMENT_URL=http://localhost:3000 PREVIEW_SMOKE_ALLOWED_HOSTS=localhost REVIEW_WEB_ACCESS_TOKEN=local-access-token node scripts/preview-smoke.mjs` | Passed |
| Agent-browser preview smoke | `DEPLOYMENT_URL=http://localhost:3000 REVIEW_WEB_ACCESS_TOKEN=local-access-token AGENT_BROWSER_CMD=agent-browser PREVIEW_SMOKE_SCREENSHOT=dogfood-output/issue-35/review-room-authenticated-smoke.png bash scripts/agent-browser-preview-smoke.sh` | Passed |

Screenshots were captured under `dogfood-output/issue-35/` for local evidence
and are intentionally not committed.

## External Production Gates

These gates are deployment-environment checks, not repository implementation
work. They must be completed before exposing the platform to production users.

1. Link or create the Vercel project for `apps/review-web`; this repository has
   no committed `.vercel/project.json`, and the connected Vercel accounts did
   not expose an obvious `agent-review` project during signoff.
2. Configure Vercel encrypted environment variables:
   `REVIEW_WEB_SERVICE_URL`, `REVIEW_WEB_SERVICE_TOKEN`, and
   `REVIEW_WEB_ACCESS_TOKEN`.
3. Deploy Review Room preview and run:
   `node scripts/preview-smoke.mjs` and
   `bash scripts/agent-browser-preview-smoke.sh` against the preview URL.
4. Deploy the review service with durable Postgres, auth required, provider
   credentials, and GitHub App credentials.
5. Run the hosted CLI service smoke in
   [Release Checklist](./release-checklist.md), including submit, watch,
   status, artifact fetch, cancel, and publish against a disposable or
   explicitly approved PR.
6. Confirm deployment-edge rate limits for repeated status, SSE, artifact, and
   cancel reads.
7. Configure `OPENROUTER_API_KEY` only if `openrouter:*` model routes are
   intended to be available. Otherwise keep OpenRouter routes disabled by
   policy or treat the current missing-key doctor result as expected.

## Residual Risks

- Browser-native GitHub OAuth/session management remains out of scope for the
  current internal Review Room shell. Review Room still relies on the coarse
  access token plus server-side service token documented in
  [Review Room Deployment](../deployment/review-web.md).
- Production GitHub publication was not exercised from this local signoff
  environment because no production service deployment, GitHub App credentials,
  and approved disposable target PR were available in the workspace.
- Production Vercel deployment was not created from this branch because no
  repository-linked Review Room Vercel project or production environment
  variables were present in the workspace.
- OpenRouter provider diagnostics remain red until an operator configures
  `OPENROUTER_API_KEY` or removes OpenRouter from the intended launch policy.

## Go / No-Go

Repository code and local verification are **go** for a controlled internal
launch candidate after this issue merges.

Production launch is **no-go** until the external production gates above are
completed and recorded in the operator release ledger.
