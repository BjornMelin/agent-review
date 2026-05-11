# ADR-0004: TypeScript Control Plane and Rust Helper Boundary

- Status: Accepted
- Date: 2026-05-11

## Context

The repository is a pnpm/Turborepo TypeScript monorepo. The service, worker,
providers, sandbox policy, reporters, and shared contracts are implemented in
TypeScript, with runtime contracts owned by `packages/review-types`.

Rust can improve a few narrow execution paths, especially diff/index parsing and
process-group supervision. Without a language-boundary decision, those helper
ideas can drift into a platform rewrite that duplicates contracts, creates two
control planes, and delays the v1 service/product work.

## Decision

Keep TypeScript as the product and orchestration control plane.

TypeScript owns:

- `apps/review-service` HTTP orchestration and server runtime
- `apps/review-worker` detached execution coordination
- provider registry, model policy, AI SDK, and Vercel AI Gateway integration
- Vercel Workflow and Vercel Sandbox orchestration
- `packages/review-types` Zod schemas and generated JSON Schema artifacts
- the primary CLI surface and the future Review Room web application

Allow Rust only as helper crates that replace fragile implementation details and
delete more complexity than they introduce. The first eligible Rust helpers are:

- diff/index parsing and changed-line indexing
- cancellable process-group supervision for Codex and local commands

`packages/review-types` remains the schema source of truth. Rust data transfer
types must be generated from the emitted JSON Schema, checked for drift in CI,
and treated as downstream artifacts. Rust code must not define a competing
canonical request, result, lifecycle event, provider, sandbox, or API schema.
The root Cargo workspace and `crates/review-contracts` provide that generation
and parity gate before any Rust helper behavior is allowed to ship.
`crates/review-git-diff` is the first admitted helper: TypeScript still owns Git
CLI collection, while Rust validates the generated `ReviewRequest`, performs
diff parse/filter/index work, and returns the normalized helper output over a
stdin/stdout JSON contract.

Postgres with Drizzle is the target durable store for run, event, and artifact
metadata. Vercel Workflow coordinates execution, retries, and resumption; it
does not replace queryable durable state. GitHub identity plus scoped service
tokens are the target authorization model. The first web product surface is the
Next.js Review Room, not a native desktop shell.

Each roadmap issue continues to ship as one branch and one pull request. Before
opening a PR, the branch must pass focused local validation and a local
subagent review appropriate to the touched surface. Hosted CI and PR review
threads must be clean before merge.

## Rust Admission Criteria

A Rust helper is admissible only when all of these are true:

- The helper replaces an existing fragile or duplicated implementation and the
  PR deletes the old canonical path.
- The helper has a narrow stdin/stdout, file, or process contract that can be
  exercised without booting the service.
- TypeScript remains the caller and orchestration owner.
- Contract types are generated from `review-types` JSON Schema and validated by
  CI; hand-authored duplicate DTOs are not accepted, and Rust callers must parse
  external payloads through schema-validating helpers with explicit guards for
  non-JSON-Schema Zod refinements before constructing DTOs.
- A conformance corpus proves parity with the existing TypeScript behavior
  before the call site is switched.
- Benchmarks or targeted runtime tests prove the helper is measurably better for
  the path it replaces.
- The PR removes dual canonical paths after cutover. Temporary comparison code
  is allowed only inside tests, benchmarks, or migration fixtures.
- The PR has a clear kill switch: if parity or performance gates fail, remove
  the Rust helper from the branch rather than preserving a permanent fallback.

Rust service rewrites, native CLI rewrites, Tauri applications, and Ratatui TUIs
are expansion tracks. They are not v1 blockers and must wait until the service
API, durable store, GitHub identity/scoped-token auth, and Review Room
contracts are stable enough to justify a second product surface.

## Consequences

### Positive

- Prevents a broad Rust rewrite from competing with the current service roadmap.
- Keeps one canonical schema owner while still allowing stronger native helpers.
- Forces Rust additions to prove deletion, parity, and performance before
  entering the runtime path.
- Makes later TUI, Tauri, and Rust service discussions explicit expansion work
  instead of implicit drift.

### Negative

- Rust helpers require generation, parity, and benchmark infrastructure before
  they can replace TypeScript paths.
- Some Rust-native designs may be deferred even when they are technically
  feasible.
- TypeScript remains responsible for orchestration complexity until a later ADR
  accepts a product-level language change.

## Alternatives Considered

- Full Rust service rewrite: rejected because it would duplicate HTTP, provider,
  workflow, sandbox, and schema ownership before the v1 product surface is
  durable.
- Native Rust CLI as the primary interface: rejected for v1 because the current
  TypeScript CLI already shares package contracts with the service.
- Tauri-first product surface: rejected for v1 because Tauri capability and IPC
  design should wrap a stable service API, not define it.
- No Rust in the repository: rejected because diff parsing and process
  supervision are narrow enough to benefit from native helpers when parity and
  deletion gates are enforced.

## References

- `packages/review-types/src/index.ts` `buildJsonSchemaSet()`
- `docs/architecture/spec/system-overview.md`
- `docs/architecture/spec/schema-and-provider-contracts.md`
- https://docs.rs/typify/latest/typify/
- https://docs.rs/globset/latest/globset/
- https://docs.rs/command-group/latest/command_group/
- https://vercel.com/docs/functions/runtimes/rust
- https://v2.tauri.app/security/capabilities/
