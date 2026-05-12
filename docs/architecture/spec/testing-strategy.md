# Testing Strategy

## Service and Worker Contract Harness

The service-worker harness exercises route behavior through
`createReviewServiceApp()` with `app.request()`. Tests must not bind a network
port. This keeps Hono route tests fast, deterministic, and aligned with the
production app factory contract.

The harness owns these test doubles:

- Deterministic provider mocks that return stable models, findings, and
  artifacts without network calls.
- Fake worker implementations for detached `start`, `get`, and `cancel`
  behavior.
- Fake service stores for inspecting route-visible records without depending on
  process-global state.
- Fixed clocks and UUID sequences for stable lifecycle events and response
  payloads.

Coverage expectations:

- `POST /v1/review/start` for inline, detached, invalid payload, runner failure,
  inline `remoteSandbox` rejection, detached custom-target `remoteSandbox`
  acceptance, and git-backed `remoteSandbox` rejection before dispatch.
- `GET /v1/review/:reviewId` for missing records, running detached state,
  synced terminal state, and failed inline state.
- `GET /v1/review/:reviewId/events` for deterministic replay of lifecycle
  events without waiting for heartbeat timers.
- `GET /v1/review/:reviewId/artifacts/:format` for generated artifacts,
  content types, missing artifacts, and invalid formats.
- `POST /v1/review/:reviewId/cancel` for successful detached cancellation and
  terminal-state conflicts.

Worker tests mock the Workflow runtime boundary and the review runner. They
cover Workflow-backed start/status/cancel, restart reconciliation by Workflow
run ID, failed Workflow status reads, fail-fast Workflow start errors, and
request validation before any work is started.

Contract fixes uncovered by this harness are in scope when they preserve the
published service/worker contracts. Current harness-backed invariants are:

- Service route state changes are persisted through `ReviewStoreAdapter`, not
  only by mutating an in-memory object reference.
- Live SSE listeners are process-local by review ID so copy-on-read or durable
  stores do not drop terminal lifecycle events, and event streams poll detached
  state while clients are connected.
- Artifact reads sync detached terminal state before deciding readiness.
- Cancel conflict responses sync detached terminal state before returning the
  current status.
- Detached worker cancellation propagates Workflow cancellation failures instead
  of marking local success, so service routes can return canonical runtime
  errors.
- Durable service storage is exercised with PGlite-backed tests covering schema
  migration, restart hydration, event sequence trimming, artifact metadata,
  status transitions, and cascade deletion.
- Remote sandbox coverage uses deterministic fakes for Vercel Sandbox calls and
  asserts deny-all policy, artifact extraction, sandbox audit propagation, and
  inline service rejection.

## Service and Worker Package Script Policy

`apps/review-service` and `apps/review-worker` run `vitest run` directly. These
packages own the service-worker contract harness, so CI must fail if either
suite disappears. Remaining packages may keep `--passWithNoTests` until their
own suites are hardened under a scoped issue.

## Fixture Rules

- Prefer in-memory fakes over module mocks for service route tests.
- Keep provider and worker fixtures deterministic; do not use real time,
  randomness, network, or process-global state unless explicitly under test.
- Assert HTTP payloads through the shared schemas or stable public fields.
- Avoid broad snapshots. Route and lifecycle assertions should name the contract
  fields that matter.
- Keep failure fixtures explicit: invalid payloads, provider failures, Workflow
  failures, lifecycle replay, cancellation, and terminal states.

## Rust Contract Parity

`crates/review-contracts` validates that committed `review-types` JSON Schema
artifacts can generate Rust DTOs with `typify`.

Coverage expectations:

- Snapshot the schema manifest so additions/removals are reviewed deliberately.
- Compile and test representative generated DTOs for `ReviewRequest`,
  `ReviewResult`, and `SandboxAudit`.
- Exercise the Rust parser helpers with positive payloads and invalid
  constraint cases, including explicit semantic guards for Zod refinements that
  JSON Schema cannot encode, so generated DTOs are never treated as validation
  owners.
- Keep Rust DTOs generated from JSON Schema only; do not hand-write duplicate
  boundary structs.
- Run `pnpm rust:check` or the equivalent Cargo format, clippy, and test ladder
  for any change touching `Cargo.toml`, `Cargo.lock`, or `crates/*`.

## Git Diff Corpus and Rust Diff-Index Gate

`packages/review-git/test/fixtures/diff-corpus/expected.json` is the stable
diff/index corpus. The Vitest corpus builds real temporary Git repositories and
normalizes absolute paths to `<repo>/...` so review diffs stay deterministic
while still asserting absolute-path semantics.

Coverage expectations:

- Staged, unstaged, untracked, binary, rename, delete, no-newline, large file,
  quoted path, CRLF, submodule, and path-filter cases.
- Expected chunk file names, normalized absolute paths, changed-line indexes,
  Git context, and metadata flags for binary/rename/delete/new-file/submodule
  behavior.
- Path-filter fixtures assert the `chunk.file` values consumed by the Rust
  include/exclude filtering path used by production `review-git`.

`crates/review-git-diff` is the production Rust diff-index helper. It exposes a
narrow `review-git-diff index` stdin/stdout JSON contract:

- input: `{ request, patch }`, where `request` is validated through generated
  `ReviewRequest` DTO parsing and `patch` is unified git diff text collected by
  TypeScript.
- output: `{ patch, chunks, changedLineIndex }`, where `patch` is the filtered
  per-file patch text, `chunks` are normalized diff chunks, and
  `changedLineIndex` is an array of absolute-path/line-list tuples converted
  back to the TypeScript `Map<string, Set<number>>` shape.

The legacy TypeScript parser is retained only as `packages/review-git`
test-support baseline code for parity checks; production `review-git` no longer
ships a second parser/filter owner.
`packages/review-git` package build/test scripts prebuild the Rust helper. The
build script copies the helper into `dist/bin/review-git-diff`, which is part of
the declared Turbo `dist/**` build output. The runtime adapter resolves
`REVIEW_AGENT_DIFF_INDEX_BIN`, the packaged `dist/bin` helper, `target/debug`,
or `target/release`; it does not run Cargo during production request handling
unless the development-only `REVIEW_AGENT_DIFF_INDEX_ALLOW_BUILD=1` escape hatch
is explicitly set. `packages/review-git/turbo.json` adds `Cargo.toml`,
`Cargo.lock`, `crates/review-contracts/**`, and `crates/review-git-diff/**` to
the package build inputs so cached `dist/bin` helpers cannot drift from Rust
source changes.

Pass/fail gates:

- `pnpm --filter @review-agent/review-git test` must pass the corpus and the
  default Rust parser/index performance suite.
- `pnpm git:benchmark` runs the strict corpus/benchmark gate used by CI.
- `pnpm ci:contracts` regenerates committed JSON Schema artifacts, fails on
  drift under `packages/review-types/generated/json-schema/`, and runs
  `cargo test -p review-agent-contracts --locked`.
- `pnpm ci:security` runs the production pnpm advisory audit and RustSec
  `cargo audit --deny warnings` gate.
- `REVIEW_AGENT_STRICT_PERF=1` turns parser budgets into hard assertions:
  collecting/parsing the real large uncommitted suite must stay under 15s, and
  the synthetic 240-file Rust parser/index path must stay under
  `max(1000ms, TypeScript baseline duration * 20)`.
- The Rust output must match the full corpus and synthetic benchmark chunks for
  file, absolute path, changed lines, filtered patch text, and metadata flags.
  Tests prebuild the helper before timing parser work.

Kill-switch criteria:

- If the Rust helper fails corpus parity, regresses benchmark gates, or adds
  more maintenance weight than it removes, remove the helper from the branch
  rather than preserving a permanent TypeScript fallback.
