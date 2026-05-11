# One-Issue-One-PR Release Playbook

## Purpose

This playbook is the operating contract for roadmap execution after the issue
set is created. Each roadmap lane ships as one issue, one branch, and one pull
request into `main`, then the next issue starts only after the previous PR is
merged and the linked issue is closed.

Use this playbook for release-roadmap issues, dependency modernization waves,
security hardening lanes, runtime refactors, product UI branches, and follow-up
cleanup work that must be reviewable and independently reversible.

## External Rules

- Conventional Commits v1.0.0 defines the commit shape
  `<type>[optional scope]: <description>` and maps `fix` to PATCH, `feat` to
  MINOR, and `BREAKING CHANGE` or `!` to MAJOR SemVer impact:
  https://www.conventionalcommits.org/en/v1.0.0/
- GitHub Issues are the tracked unit for tasks, bugs, features, and release
  work: https://docs.github.com/en/issues/tracking-your-work-with-issues/learning-about-issues/about-issues
- Pull requests must link issues with closing keywords such as `Closes #10`
  when targeting the default branch so GitHub closes the issue on merge:
  https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue

## Release Ledger Template

Maintain one ledger row per issue while executing a release train. A temporary
working ledger can live in agent notes during active work, but durable release
records should be committed under `docs/release/` when they need to survive the
session.

| Field | Required value |
| --- | --- |
| Issue | GitHub issue number and title. |
| Scope | One-sentence outcome boundary and explicit non-goals. |
| Branch | Conventional branch name, for example `docs/issue-14-release-playbook`. |
| PR | Pull request number and URL after publication. |
| Commits | Scoped Conventional Commit subjects and SemVer impact. |
| Local validation | Exact commands run locally and pass/fail result. |
| Subagent review | Reviewer roles used, findings fixed, and final no-finding evidence. |
| Hosted CI | GitHub checks, status, and retry/fix notes. |
| Hosted review | CodeRabbit, Copilot, and human review status with unresolved thread count. |
| Merge | Merge commit SHA, merge method, and branch deletion status. |
| Issue closure | Closed timestamp or reason still open. |
| Docs/deploy notes | Docs changed, deployment notes, or explicit `N/A`. |
| Residual risk | Known constraints or explicit `None`. |
| Follow-ups | Linked follow-up issue numbers or explicit `None`. |

Use this row format when a release needs a Markdown ledger:

```markdown
| Issue | Scope | Branch | PR | Commits | Local validation | Subagent review | Hosted CI | Hosted review | Merge | Issue closure | Docs/deploy notes | Residual risk | Follow-ups |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #NN title | Outcome boundary; non-goals | `type/issue-nn-slug` | #PR | `docs(scope): subject`; SemVer none | `cmd` passed | roles; no findings | checks passed | approved; 0 unresolved threads | merged SHA; squash; branch deleted | closed as completed | docs updated; deploy N/A | None | None |
```

## Execution Loop

### 1. Select the next issue

1. Fetch the live issue body and comments.
2. Confirm earlier roadmap issues are merged and closed.
3. Read the repo instructions, current docs, and code surfaces that own the
   issue.
4. If the issue is stale, update the PR body or issue comments during
   implementation rather than preserving obsolete assumptions.

### 2. Start the branch

1. Sync `main` from `origin/main`.
2. Verify a clean worktree with `git status --short --branch`.
3. Create one branch from `main` using a scoped name:
   `type/issue-nn-short-slug`.
4. Do not stack roadmap branches unless the issue explicitly says to stack.

### 3. Research and decide

1. Use repo docs and code as the local authority.
2. Use official docs, package source, release notes, or API references for
   dependency, platform, CI, security, or public-contract decisions.
3. Record meaningful decisions in the PR body and, when durable, in specs,
   ADRs, release docs, or issue comments.
4. Mark any claim `UNVERIFIED` if it could not be confirmed from live evidence.

### 4. Implement narrowly

1. Keep the branch scoped to the linked issue.
2. Prefer hard cuts that remove obsolete code, duplicate ownership, and unused
   dependencies when the issue calls for cleanup.
3. Update tests and docs in the same branch when behavior, contracts, commands,
   flags, schemas, runtime policy, or release process changes.
4. Move adjacent discoveries to follow-up issues unless they block the current
   issue.

### 5. Validate locally

Run focused package checks first, then the repo-level gates required by the
touched surface. For ordinary code lanes, prefer:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

For docs-only lanes, run the strongest available local validation. If the repo
has no docs-specific checker, run `pnpm check` and record that no docs-specific
checker exists.

### 6. Run pre-PR subagent review

Before opening a PR, run focused subagent review for the changed surface:

- Runtime or backend: correctness, security, error handling, and tests.
- Frontend: rendered UI, accessibility, responsiveness, and visual regressions.
- CLI: argument contract, exit codes, stdin/stdout behavior, and config/env
  precedence.
- Docs: source-of-truth alignment, stale references, and missing cross-links.

Fix valid findings, rerun focused validation, and repeat until the final
subagent pass has no actionable findings. Do not delegate the critical-path
implementation if local work is faster and more reliable.

### 7. Commit semantically

Commit only files that belong to the current issue. Use reviewable
Conventional Commits:

- `feat(scope): ...` for user-visible capability or API additions.
- `fix(scope): ...` for bug fixes and correctness repairs.
- `test(scope): ...` for test harnesses or coverage-only changes.
- `docs(scope): ...` for documentation-only changes.
- `refactor(scope): ...` for behavior-preserving code restructuring.
- `chore(scope): ...` for tool, metadata, or repo-maintenance changes.
- Add `!` or a `BREAKING CHANGE:` footer only for a real breaking contract.

Split commits only when the issue naturally contains separate semantic lanes.
Avoid many tiny commits that make review harder.

### 8. Open the PR

Create the PR into `main` and include:

- `Closes #NN`.
- Summary of behavior or docs changed.
- Validation evidence with exact commands.
- Subagent review evidence.
- Docs impact.
- Provider, deployment, or migration notes.
- Screenshots or browser evidence when UI is touched.
- Residual risks and follow-ups.

## Hosted Review and CI Policy

1. Wait for all required GitHub checks.
2. Inspect failed CI logs before retrying.
3. Fix branch-caused failures with a focused commit and push.
4. Retry only failures classified as flaky or unrelated after inspecting logs.
5. Fetch live review threads after every push.
6. Verify every CodeRabbit, Copilot, or human finding against the current code.
7. Fix valid findings with tests when applicable.
8. Reply only when a finding is stale, invalid, or intentionally rejected.
9. Prefix CodeRabbit disagreement replies with `@coderabbitai` and include the
   evidence or design reason.
10. Resolve addressed review threads only after the fixing commit is pushed.
11. Request a fresh bot review if CodeRabbit remains stale or pending after the
    branch is otherwise green.
12. Merge only when checks pass, CodeRabbit is approved or clean, and there are
    zero unresolved hosted review threads.

## Merge and Closeout

1. Use a merge method that keeps the final history conventional. Squash merge is
   preferred when the branch contains iterative review-fix commits.
2. Delete the remote branch after merge.
3. Confirm the linked issue is closed with `state_reason: completed`.
4. Update the release ledger row with merge SHA, validation, review state, and
   residual risks.
5. Return to `main`, sync from `origin/main`, and start the next issue only
   after this closeout is complete.

## Stop Rules

Pause and ask for user input only when proceeding would risk data loss, secret
exposure, production impact without approval, destructive git history changes,
or a public-contract break that the issue did not authorize.

Otherwise choose the smallest defensible path, keep evidence, and continue the
one-issue loop.
