# Release Checklist

## Issue-Backed Execution

Use the
[one-issue-one-PR release playbook](./one-issue-one-pr-playbook.md) for roadmap
execution, release-train ledgers, PR body evidence, hosted review handling, and
issue closeout.

## Preconditions

1. `pnpm install --frozen-lockfile`
2. `pnpm ci:contracts`
3. `pnpm ci:security`
4. `pnpm check`
5. `pnpm build`
6. `bash scripts/repro-check.sh`

## CI Evidence

Every PR must keep the branch-protection `check` job green. The upstream lanes
that feed it are documented in the
[CI hardening runbook](./ci-hardening.md):

1. `Static checks`
2. `Generated contracts`
3. `Rust gates`
4. `Typecheck, tests, and builds`
5. `Dependency security audit`
6. `Vercel preview smoke` when a Vercel preview deployment signal is emitted

Before merging contract or Rust changes, verify the generated-schema drift gate
and the relevant Cargo gate fail on an intentional temporary break, then revert
that break and rerun the clean gate.

## Functional Verification

1. Run CLI parity smoke tests:
   1. `pnpm --filter @review-agent/review-cli dev run --uncommitted --provider codex --format json --output -`
   2. `pnpm --filter @review-agent/review-cli dev doctor --provider all --json`
2. Run hosted CLI service smoke tests:
   1. Start the service and apply required database migrations.
   2. Configure `REVIEW_AGENT_SERVICE_URL` and a
      `REVIEW_AGENT_SERVICE_TOKEN` scoped for `review:start`, `review:read`,
      `review:cancel`, and `review:publish`.
   3. Submit a commit-backed PR review and save the returned `reviewId` for
      steps 4, 5, 6, and 9:
      `reviewId=$(pnpm --filter @review-agent/review-cli dev submit --commit <sha> --repo <owner/name> --pull-request <number> --provider gateway --format json --output - | jq -r .reviewId)`
   4. `pnpm --filter @review-agent/review-cli dev watch "$reviewId"`
   5. `pnpm --filter @review-agent/review-cli dev status "$reviewId" --output -`
   6. `pnpm --filter @review-agent/review-cli dev artifact "$reviewId" markdown --output -`
   7. Submit a disposable commit-backed PR review and save its `cancelReviewId`:
      `cancelReviewId=$(pnpm --filter @review-agent/review-cli dev submit --commit <sha> --repo <owner/name> --pull-request <number> --provider gateway --format json --output - | jq -r .reviewId)`
   8. Cancel the disposable review:
      `pnpm --filter @review-agent/review-cli dev cancel "$cancelReviewId" --output -`
   9. Publish the successful review from step 3, not the cancelled disposable
      review from step 8:
      `pnpm --filter @review-agent/review-cli dev publish "$reviewId" --output -`
3. Run service API smoke tests:
   1. Start service: `pnpm --filter @review-agent/review-service dev`
   2. Submit inline review request to `/v1/review/start`
   3. Verify `/v1/review/:reviewId/events` lifecycle ordering
4. Validate detached flow:
   1. Start detached run (`delivery=detached`)
   2. Poll `/v1/review/:reviewId`
   3. Cancel using `/v1/review/:reviewId/cancel`
5. Run Review Room smoke tests:
   1. Start the service and configure `REVIEW_WEB_SERVICE_URL` plus a
      server-only `REVIEW_WEB_SERVICE_TOKEN`.
   2. Start Review Room with `pnpm --filter @review-agent/review-web dev`.
   3. Verify the run list loads from `GET /v1/review`.
   4. Open a run detail view and verify status metadata, findings, artifacts,
      and lifecycle events render without console errors on desktop and mobile
      viewports.
6. Run Vercel preview smoke checks for hosted Review Room:
   1. Confirm the preview deployment has `REVIEW_WEB_SERVICE_URL`,
      `REVIEW_WEB_SERVICE_TOKEN`, and `REVIEW_WEB_ACCESS_TOKEN` configured.
   2. Confirm the automated GitHub workflow does not pass repository secrets to
      PR preview deployments.
   3. Confirm the workflow uses `environment_url` or repository-dispatch
      `client_payload.url` and checks out trusted scripts from `main`.
   4. Run `node scripts/preview-smoke.mjs` against the preview URL.
   5. Run `bash scripts/agent-browser-preview-smoke.sh` and preserve the
      screenshot artifact when UI behavior changed.

## Security and Policy Verification

1. Validate sandbox blocked command behavior (expect explicit denial).
2. Validate sandbox output/artifact budget enforcement.
3. Validate lifecycle event correlation IDs are present on all events.
4. Validate redaction metadata appears in sandbox audit output.

## Artifacts and Reproducibility

1. Ensure SARIF/JSON/Markdown artifacts are deterministic over repeated runs.
2. Ensure reproducibility script reports matching build hashes.

## Documentation and Handoff

1. Update architecture docs for any behavior changes.
2. Confirm `.agents/plans/2026-03-01-review-agent-platform-final-spec.md` checklist is fully checked.
3. Capture release notes (version, notable changes, known constraints).
