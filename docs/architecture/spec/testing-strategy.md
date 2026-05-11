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

## Git Diff Corpus and Rust Candidate Gate

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
- Path-filter fixtures assert the `chunk.file` values consumed by
  `review-core` include/exclude filtering, even though filtering remains owned
  by `review-core`.

`crates/review-git-diff` is the Rust candidate helper. It exposes a narrow
`review-git-diff parse --cwd <repo>` stdin/stdout contract for benchmarks and
fixtures only; production diff collection still calls the TypeScript parser.

Pass/fail gates:

- `pnpm --filter @review-agent/review-git test` must pass the corpus and the
  default parser/index performance suite.
- `pnpm git:benchmark` runs the strict corpus/benchmark gate used by CI.
- `REVIEW_AGENT_STRICT_PERF=1` turns parser budgets into hard assertions:
  collecting/parsing the real large uncommitted suite must stay under 15s, and
  the synthetic 240-file parser/index path must stay under 1.5s.
- `REVIEW_AGENT_RUST_DIFF_BENCH=1` runs the Rust candidate comparison. The Rust
  output must match the full corpus and synthetic benchmark chunks for file,
  absolute path, changed lines, and metadata flags. The benchmark prebuilds the
  candidate binary before timing parser work. In strict mode the CLI parser
  comparison must stay under `max(1000ms, TypeScript duration * 20)`.

Kill-switch criteria:

- If the Rust candidate fails corpus parity, regresses benchmark gates, or adds
  more maintenance weight than it removes, keep `packages/review-git` as the
  canonical parser and remove the Rust candidate from the migration branch.
- A later cutover PR must delete the TypeScript parser path it replaces; this
  issue permits dual code only inside fixtures, tests, and benchmarks.
