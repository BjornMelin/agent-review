# Release Checklist

## Issue-Backed Execution

Use the
[one-issue-one-PR release playbook](./one-issue-one-pr-playbook.md) for roadmap
execution, release-train ledgers, PR body evidence, hosted review handling, and
issue closeout.

## Preconditions

1. `pnpm install --frozen-lockfile`
2. `pnpm check`
3. `pnpm build`
4. `bash scripts/repro-check.sh`

## Functional Verification

1. Run CLI parity smoke tests:
   1. `pnpm --filter @review-agent/review-cli dev -- run --uncommitted --provider codex --format json --output -`
   2. `pnpm --filter @review-agent/review-cli dev -- doctor --provider all --json`
2. Run service API smoke tests:
   1. Start service: `pnpm --filter @review-agent/review-service dev`
   2. Submit inline review request to `/v1/review/start`
   3. Verify `/v1/review/:reviewId/events` lifecycle ordering
3. Validate detached flow:
   1. Start detached run (`delivery=detached`)
   2. Poll `/v1/review/:reviewId`
   3. Cancel using `/v1/review/:reviewId/cancel`

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
