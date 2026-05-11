# Hosted Review Service Threat Model

Status: Accepted  
Issue: [#12](https://github.com/BjornMelin/agent-review/issues/12)  
Last updated: 2026-05-11

## Purpose

This document defines the security model for hosted review execution before the
service processes private repository paths, prompts, artifacts, provider output,
GitHub write operations, durable workflow state, or sandbox commands.

This is a design and acceptance-gate document. It does not itself implement
authentication, authorization, sandbox execution, GitHub publishing, or web UI
controls. Service durable storage is implemented separately under
[ADR-0005](../adr/0005-durable-review-storage.md); identity-bound ownership and
security audit fields remain gated by the later auth, enforcement, and
observability issues mapped below.

## Source Evidence

Repository evidence:

- Service routes are registered in `apps/review-service/src/app.ts`.
- Service auth currently defaults to allow-all unless an injected auth policy
  denies the request.
- `remoteSandbox` is currently rejected by `review-service`.
- Worker detached execution uses Vercel Workflow runtime APIs, while durable
  service storage remains the queryable run/event/artifact state boundary.
- Sandbox policy and audit controls live in
  `packages/review-sandbox-vercel/src/index.ts`.
- Request/result/lifecycle/provider schemas are owned by
  `packages/review-types/src/index.ts`.
- Provider construction and OpenAI-compatible model policy are owned by
  `packages/review-provider-registry/src/index.ts`.
- Optional Convex metadata mirroring is wired from
  `apps/review-service/src/server.ts` through
  `packages/review-convex-bridge/src/index.ts`.
- Service durable storage is selected from `DATABASE_URL` or `POSTGRES_URL` in
  `apps/review-service/src/server.ts` and implemented by
  `apps/review-service/src/storage`.

External authority:

- OWASP API Security Top 10 2023 is the baseline API abuse taxonomy for
  object-level authorization, authentication, resource consumption, function
  authorization, SSRF, configuration, inventory, and unsafe third-party API use:
  https://owasp.org/API-Security/
- Vercel Sandbox is documented as an isolated Firecracker microVM with a
  dedicated filesystem, process isolation, and controlled outbound network
  access: https://vercel.com/docs/vercel-sandbox and
  https://vercel.com/docs/vercel-sandbox/concepts
- Vercel Sandbox network policies support deny-all and allowlisted domains, and
  a running sandbox can be locked down after bootstrap:
  https://vercel.com/docs/vercel-sandbox/concepts/firewall
- Vercel Workflow is durable, resumable, and records step input/output/error
  state and event logs automatically: https://vercel.com/docs/workflow
- GitHub pull request review APIs expose review/comment bodies, review state,
  author association, commit IDs, and pull request URLs:
  https://docs.github.com/en/rest/pulls/reviews
- GitHub pull request review comment APIs expose inline comment bodies, paths,
  line positions, commit IDs, and reply/update/delete operations:
  https://docs.github.com/en/rest/pulls/comments

## Security Objectives

- Private repository code, paths, diffs, prompts, provider outputs, artifacts,
  sandbox command output, and workflow/store records are treated as sensitive by
  default.
- Hosted endpoints only operate for an authenticated principal authorized for
  the target GitHub repository, organization, review run, and artifact.
- Local-trusted execution never crosses into hosted execution without explicit
  user intent and hosted policy checks.
- Remote sandbox execution never receives unrestricted network, filesystem,
  command, environment, token, or artifact access.
- Provider and GitHub integrations receive the minimum content and permissions
  required for the requested operation.
- Every externally observable record has retention, redaction, and audit
  semantics before production use.

## Data Classes

| Class | Examples | Default handling |
| --- | --- | --- |
| Public metadata | package names, public docs links, non-sensitive config names | May be logged and documented. |
| Repository metadata | owner, repo, branch, commit SHA, PR number, changed file paths | Sensitive when repo is private; require repo authorization before disclosure. |
| Private code context | diffs, source snippets, prompt instructions, cwd, include/exclude path filters | Sensitive; never log raw values, never persist without retention policy, never publish without explicit target authorization. |
| Provider material | model ID, prompt, rubric, provider raw output, generated findings | Sensitive; redact before logs, persist only as review artifacts with run ownership. |
| Credentials and service tokens | GitHub App tokens, service tokens, provider API keys, Codex/OpenAI tokens, Vercel tokens | Secret; never included in request bodies, artifacts, provider prompts, sandbox env except allowlisted ephemeral tokens. |
| Sandbox material | uploaded files, command args, command output, env vars, sandbox audit, network allowlists | Sensitive; enforce budgets, redaction, lifecycle cleanup, and audit integrity. |
| Durable state | run records, lifecycle events, artifact metadata, workflow IDs, audit events | Sensitive operational metadata; queryable by authorized owner only. |
| Mirrored metadata | optional Convex mirror fields, derived summaries, correctness labels, provider/model identifiers | Sensitive external sink; disabled or explicitly redacted, scoped, retained, and documented before hosted use. |
| Published output | GitHub checks, SARIF, PR comments, review comments, web-visible findings | Must be deliberately published and idempotent; never include hidden prompts/secrets. |

## Actors

- Authenticated developer: submits local or hosted review requests and can read
  their own authorized runs.
- GitHub App installation: proves repository authorization and publishes checks,
  comments, SARIF, and review results within installation permissions.
- Service client or CI token: submits reviews on behalf of automation with
  scoped service credentials.
- Hosted review service: validates requests, owns authz decisions, coordinates
  providers/workers/storage, and serves artifacts.
- Detached worker and Workflow runtime: executes long-running review work and
  records progress.
- Vercel Sandbox: runs untrusted commands and agent workloads inside an isolated
  microVM when remote sandbox mode is implemented.
- Model provider: receives prompt/code context and returns review output.
- Postgres/Drizzle store: durable review metadata, lifecycle event, artifact,
  status transition, retention, and Workflow run ID index.
- Optional Convex metadata mirror: current non-blocking mirror for selected
  review metadata and derived summaries; production use requires explicit
  redaction, retention, tenant scoping, and disable/enable policy.
- Review Room user: future web UI user reading and triaging runs.
- Malicious external attacker: probes unauthenticated or weakly authorized HTTP
  endpoints.
- Malicious or compromised repo contributor: controls source code, filenames,
  diffs, comments, and prompts that can influence model/provider behavior.
- Compromised dependency/provider/sandbox workload: attempts token theft,
  exfiltration, persistence, or lateral movement.
- Operator/maintainer: can inspect logs and deployments; must not need raw
  private code to operate the service.

## Trust Boundaries

| Boundary | Crossing | Primary risk | Required control |
| --- | --- | --- | --- |
| TB-1 Public HTTP to service | `/v1/review/*` requests, SSE, artifact reads, cancellation | Unauthenticated access, object-level authorization failures, resource exhaustion | GitHub identity or scoped service token, per-run owner checks, request size/rate limits. |
| TB-2 Service to local filesystem/git | `cwd`, refs, path filters, diff collection | Host path traversal and unauthorized repo reads | Hosted cwd allowlist and repo checkout root binding; never trust caller-provided absolute host paths. |
| TB-3 Service to worker/Workflow | detached run start/status/cancel and lifecycle events | Lost auth context, replay, cross-run data exposure, durable state leakage | Persist principal, repo, permissions, request hash, and run correlation; authorize every status/artifact read. |
| TB-4 Service/worker to provider | prompts, rubrics, diffs, model IDs, provider output | private code disclosure, prompt injection, unsafe output trust | Provider allowlist, budget controls, output schema validation, provider telemetry, prompt/data minimization. |
| TB-5 Service/worker to sandbox | uploaded files, commands, env, network, stdout/stderr | command injection, token exfiltration, SSRF, filesystem escape, noisy artifacts | command/env allowlists, deny-all default network, allowlisted bootstrap, microVM lifecycle cleanup, budget and redaction gates. |
| TB-6 Service/worker to durable store | run/event/artifact metadata and audit records | tenant data mixing, stale retention, unbounded sensitive storage | tenant/repo/run partitioning, retention and deletion policy, audit log immutability for security events. |
| TB-7 Service to GitHub APIs | GitHub App tokens, Checks, SARIF, PR comments | overbroad token use, publishing to wrong repo/commit, comment spam | installation-scoped tokens, commit/repo binding, idempotency keys, publish permission checks. |
| TB-8 Local CLI to hosted service | future CLI submit/watch/publish | accidental private data upload, token leakage | explicit `submit` command, endpoint allowlist, token source precedence, dry-run summary before upload. |
| TB-9 Review Room web UI | browser auth, run lists, artifact/finding views, cancel/publish/triage mutations | XSS, IDOR, CSRF, over-disclosure, stale authorization | server-side authorization, CSRF/origin/CORS policy, SameSite/session controls, CSP, escaped markdown/code rendering, no raw secret display. |
| TB-10 Service/core to optional metadata mirrors | Convex bridge writes and future external mirrors | derived private-code leakage, tenant mixing, unbounded third-party retention | disabled-by-default hosted posture unless explicitly configured with redaction, tenant scoping, retention, and audit. |

## Abuse Cases and Required Mitigations

### A1. Unauthenticated Hosted Review Execution

An attacker submits `POST /v1/review/start` and causes provider calls, local
filesystem reads, detached runs, or artifact generation.

Required controls:

- All hosted `/v1/*` routes require auth by default.
- Anonymous local-dev allow-all must be opt-in and impossible in production.
- CI/service clients use scoped service tokens with explicit repository claims.
- Start, status, events, artifact, and cancel endpoints enforce the same
  authorization model.

Mapped issues: [#23](https://github.com/BjornMelin/agent-review/issues/23),
[#24](https://github.com/BjornMelin/agent-review/issues/24),
[#26](https://github.com/BjornMelin/agent-review/issues/26),
[#27](https://github.com/BjornMelin/agent-review/issues/27).

### A2. Broken Object Level Authorization for Runs and Artifacts

An authenticated user guesses or obtains a `reviewId` and reads another
repository's status, events, artifacts, or cancellation state.

Required controls:

- Before hosted production, every persisted run stores principal, GitHub
  installation, repo owner/name, repo visibility, commit/ref, request hash, and
  created-by actor.
- #15 provides the base durable run record and retention/event/artifact metadata;
  #23, #24, and #30 add the identity, authorization, and security-audit fields.
- Read/cancel/artifact/event endpoints authorize against stored run ownership,
  not only token validity.
- Review IDs remain unguessable, but secrecy of IDs is not the authorization
  control.

Mapped issues: [#15](https://github.com/BjornMelin/agent-review/issues/15),
[#16](https://github.com/BjornMelin/agent-review/issues/16),
[#23](https://github.com/BjornMelin/agent-review/issues/23),
[#24](https://github.com/BjornMelin/agent-review/issues/24),
[#27](https://github.com/BjornMelin/agent-review/issues/27).

### A3. Host Filesystem or Repository Escape Through `cwd` and Path Filters

Hosted requests include arbitrary absolute `cwd`, refs, include/exclude paths,
or custom prompt targets that cause the service to read host files outside the
authorized repository checkout.

Required controls:

- Hosted mode never accepts arbitrary host `cwd`; it resolves repository roots
  from GitHub authorization and managed checkout/workspace metadata.
- Path filters are evaluated relative to the repository root after
  normalization; absolute paths, `..` escapes, symlink escapes, and generated
  secrets paths are rejected.
- Local CLI retains local-trusted `cwd` semantics, but hosted service requests
  use a different policy and schema-level acceptance gate.

Mapped issues: [#13](https://github.com/BjornMelin/agent-review/issues/13),
[#17](https://github.com/BjornMelin/agent-review/issues/17),
[#20](https://github.com/BjornMelin/agent-review/issues/20),
[#23](https://github.com/BjornMelin/agent-review/issues/23),
[#24](https://github.com/BjornMelin/agent-review/issues/24).

### A4. Resource Exhaustion and Cost Abuse

Attackers or misconfigured clients submit large diffs, too many files, long
prompts, expensive models, excessive detached runs, or long SSE connections.

Required controls:

- Enforce request body size, diff byte/file budgets, prompt byte budgets,
  artifact byte budgets, max concurrent runs per repo/principal, and queue
  backpressure before provider invocation.
- Provider routing has per-model budget policy, timeouts, retry ceilings, and
  cost telemetry.
- SSE, status polling, artifact reads, and cancellation endpoints have rate
  limits.

Mapped issues: [#22](https://github.com/BjornMelin/agent-review/issues/22),
[#23](https://github.com/BjornMelin/agent-review/issues/23),
[#29](https://github.com/BjornMelin/agent-review/issues/29),
[#30](https://github.com/BjornMelin/agent-review/issues/30),
[#31](https://github.com/BjornMelin/agent-review/issues/31).

### A5. Prompt Injection and Provider Output Confusion

Repo-controlled code, comments, filenames, diffs, or custom instructions attempt
to override system policy, exfiltrate secrets, produce malicious markdown, or
publish false findings.

Required controls:

- Prompts separate system/rubric instructions from untrusted diff content.
- Provider output is treated as untrusted until parsed, normalized, location
  checked, severity bounded, and escaped for each rendering target.
- GitHub publishing and Review Room rendering never execute provider-generated
  HTML/script and never trust provider-selected repository/commit identifiers.
- Artifacts include model/provider provenance and request hash for audit.

Mapped issues: [#13](https://github.com/BjornMelin/agent-review/issues/13),
[#23](https://github.com/BjornMelin/agent-review/issues/23),
[#25](https://github.com/BjornMelin/agent-review/issues/25),
[#27](https://github.com/BjornMelin/agent-review/issues/27),
[#28](https://github.com/BjornMelin/agent-review/issues/28),
[#29](https://github.com/BjornMelin/agent-review/issues/29).

### A6. Provider or Third-Party API Data Overexposure

Private diffs, prompts, or artifacts are sent to the wrong model provider, an
unapproved provider, or a provider without project-level policy approval.

Required controls:

- Provider registry enforces provider/model allowlist, budget class, retention
  class, and diagnostics before every run.
- The request stores resolved provider/model and policy version.
- Provider selection cannot be changed by prompt content or provider output.
- Private-code prompts are minimized and redacted before provider submission
  when redaction policy applies.

Mapped issues: [#23](https://github.com/BjornMelin/agent-review/issues/23),
[#29](https://github.com/BjornMelin/agent-review/issues/29),
[#30](https://github.com/BjornMelin/agent-review/issues/30),
[#32](https://github.com/BjornMelin/agent-review/issues/32).

### A7. Sandbox Escape, Network Exfiltration, or SSRF

Untrusted commands in `remoteSandbox` attempt to reach internal services,
metadata endpoints, provider APIs, GitHub APIs, or arbitrary exfiltration
destinations.

Required controls:

- Default sandbox network policy is deny-all for untrusted execution.
- Bootstrap network access is explicit, narrow, audited, and switched to
  deny-all before untrusted commands.
- Allowed domains are policy-owned; request-provided domains do not directly
  become sandbox network policy.
- Sandbox env is allowlisted and cannot include provider/GitHub/Vercel tokens
  unless an issue explicitly requires and scopes an ephemeral token.
- Sandbox command allowlist, cwd/file path normalization, output/artifact
  budgets, and redaction are enforced before service integration.

Mapped issues: [#17](https://github.com/BjornMelin/agent-review/issues/17),
[#21](https://github.com/BjornMelin/agent-review/issues/21),
[#22](https://github.com/BjornMelin/agent-review/issues/22),
[#23](https://github.com/BjornMelin/agent-review/issues/23),
[#30](https://github.com/BjornMelin/agent-review/issues/30).

### A8. Durable Workflow Replay or State Leakage

Workflow runtime retries, replays, or persisted step logs expose private inputs
or run a non-idempotent provider/GitHub publish step multiple times.

Required controls:

- Workflow inputs and step outputs use redacted/minimized DTOs.
- Every provider call, GitHub publish, artifact write, and state transition has
  idempotency keys tied to run ID, commit SHA, provider/model, and artifact
  format.
- Workflow state stores enough audit metadata for replay debugging without raw
  private code unless retention policy permits it.
- Cancellation and leases prevent duplicate active runs for the same review.

Mapped issues: [#15](https://github.com/BjornMelin/agent-review/issues/15),
[#16](https://github.com/BjornMelin/agent-review/issues/16),
[#22](https://github.com/BjornMelin/agent-review/issues/22),
[#25](https://github.com/BjornMelin/agent-review/issues/25),
[#30](https://github.com/BjornMelin/agent-review/issues/30).

### A9. GitHub Publishing to the Wrong Repository, PR, Commit, or Thread

The service publishes checks, SARIF, comments, or review comments to a repository
or commit outside the authorized installation or outside the reviewed diff.

Required controls:

- Publish operations bind to GitHub installation ID, repo ID, PR number, base
  and head SHA, and request hash.
- Stale head SHA blocks publish unless the user explicitly accepts a refresh.
- Comments/checks/SARIF use idempotency markers and update-in-place behavior.
- GitHub API errors, rate limits, and permissions failures are surfaced without
  retry storms or partial duplicate comments.

Mapped issues: [#24](https://github.com/BjornMelin/agent-review/issues/24),
[#25](https://github.com/BjornMelin/agent-review/issues/25),
[#26](https://github.com/BjornMelin/agent-review/issues/26),
[#28](https://github.com/BjornMelin/agent-review/issues/28),
[#30](https://github.com/BjornMelin/agent-review/issues/30).

### A10. Secret Leakage Through Logs, Errors, Artifacts, or UI Rendering

Provider errors, sandbox stdout/stderr, workflow logs, Hono errors, JSON
artifacts, Markdown artifacts, SARIF payloads, or Review Room views expose
tokens, private paths, prompts, or code not intended for that audience.

Required controls:

- Error responses use stable safe messages; detailed stack traces are not served
  to callers.
- Logs and metrics exclude raw prompts/diffs/artifacts by default.
- Redaction applies before durable storage, provider output logging, sandbox
  audit records, GitHub publishing, and web rendering.
- Review Room and GitHub rendering escape Markdown/HTML and clearly mark
  provider-generated content as untrusted.

Mapped issues: [#23](https://github.com/BjornMelin/agent-review/issues/23),
[#27](https://github.com/BjornMelin/agent-review/issues/27),
[#28](https://github.com/BjornMelin/agent-review/issues/28),
[#30](https://github.com/BjornMelin/agent-review/issues/30),
[#35](https://github.com/BjornMelin/agent-review/issues/35).

### A11. Supply-Chain or Generated-Contract Drift

Generated JSON Schemas, future Rust contracts, CI scripts, and dependency
updates drift from the TypeScript Zod source of truth or introduce unreviewed
runtime behavior.

Required controls:

- Zod schemas remain canonical until an explicit ADR changes that.
- Generated JSON Schema artifacts and future Rust type artifacts have CI drift
  checks.
- Dependency upgrades require source/changelog review for provider, sandbox,
  workflow, GitHub, auth, and rendering packages.
- Rust helpers cannot define competing canonical request/result/event/provider
  contracts.

Mapped issues: [#18](https://github.com/BjornMelin/agent-review/issues/18),
[#19](https://github.com/BjornMelin/agent-review/issues/19),
[#20](https://github.com/BjornMelin/agent-review/issues/20),
[#31](https://github.com/BjornMelin/agent-review/issues/31),
[#32](https://github.com/BjornMelin/agent-review/issues/32).

### A12. Operator or Observability Overreach

Operators, logs, metrics, traces, and dashboards expose more private code,
prompts, artifacts, or user/repo metadata than necessary for debugging.

Required controls:

- Observability uses structured event names, IDs, status, durations, counts,
  redaction counters, model budget classes, and error categories instead of raw
  private payloads.
- Security-relevant decisions are auditable: authz allow/deny, cwd policy deny,
  sandbox deny, provider deny, publish deny, redaction counts, retention delete.
- Production debug tooling requires explicit elevated access and does not
  silently expand retention.

Mapped issues: [#15](https://github.com/BjornMelin/agent-review/issues/15),
[#23](https://github.com/BjornMelin/agent-review/issues/23),
[#30](https://github.com/BjornMelin/agent-review/issues/30),
[#31](https://github.com/BjornMelin/agent-review/issues/31),
[#35](https://github.com/BjornMelin/agent-review/issues/35).

### A13. Optional Metadata Mirror Overexposure

The current Convex bridge mirrors selected metadata and derived review summaries
to an external system. Even when raw diffs are not sent, summaries and correctness
labels can encode private-code-derived information.

Required controls:

- Hosted production disables optional mirrors until each sink has explicit
  tenant/repo scoping, retention, redaction, and operator-access policy.
- Mirror payloads use an allowlist and exclude raw prompts, raw diffs, artifact
  bodies, secrets, stack traces, and unredacted provider output.
- Mirror records are keyed by the service/durable `reviewId`, request hash,
  repository owner/name, installation, and commit/ref; core packages do not
  create a competing externally visible run identity for hosted mirrors.
- Mirror write failures remain non-blocking but are auditable through safe
  counters and error categories.
- Documentation names every enabled external metadata sink and its data classes.

Mapped issues: [#15](https://github.com/BjornMelin/agent-review/issues/15),
[#23](https://github.com/BjornMelin/agent-review/issues/23),
[#30](https://github.com/BjornMelin/agent-review/issues/30),
[#32](https://github.com/BjornMelin/agent-review/issues/32),
[#35](https://github.com/BjornMelin/agent-review/issues/35).

### A14. Browser Mutation Forgery and Cross-Origin State Changes

Future Review Room controls for start, cancel, triage, publish, and artifact
actions are browser-authenticated mutations. A malicious site or stale browser
session could trigger state changes if the service relies only on cookies or
token presence.

Required controls:

- Browser mutations enforce server-side authorization for the principal, run,
  repo, PR, and operation, not just UI visibility.
- CSRF tokens or equivalent double-submit/origin protections are required for
  cookie-backed sessions.
- CORS allowlists and SameSite cookie policy are explicit for production.
- Publish and cancel actions include idempotency and stale-state checks.

Mapped issues: [#24](https://github.com/BjornMelin/agent-review/issues/24),
[#27](https://github.com/BjornMelin/agent-review/issues/27),
[#28](https://github.com/BjornMelin/agent-review/issues/28),
[#35](https://github.com/BjornMelin/agent-review/issues/35).

## Cross-Issue Security Acceptance Criteria

Future issues must preserve these gates:

- #13 service-worker contract tests must include negative tests for auth-ready
  request ownership, remote sandbox rejection/current behavior, run status
  isolation, artifact access, cancellation, and unsafe provider output fixtures.
- #15 durable store must persist status, event sequence, artifact metadata, and
  retention timestamps behind the canonical service `reviewId`; #23, #24, and
  #30 must extend that durable boundary with run owner, repo, installation,
  request hash, commit/ref, and security decision audit fields before hosted
  production use. Optional metadata mirrors must be opt-in and inherit the same
  canonical service/durable `reviewId`, owner, request hash, repo, retention,
  and redaction decisions once those fields exist.
- #16 Workflow integration must prove idempotent steps, redacted durable inputs,
  lifecycle replay integrity, and no duplicate provider/GitHub side effects.
- #17 sandbox integration must keep network deny-all as default, reject
  request-owned allowlists, enforce command/env/file/output budgets, and return
  auditable redaction counters.
- #18 through #21 Rust lanes must consume generated contracts and cannot create
  a second canonical schema or bypass hosted cwd/sandbox policy.
- #22 runtime controls must enforce leases, cancellation, concurrency limits,
  backpressure, queue limits, and terminal-state transitions.
- #23 security enforcement must implement a fail-closed hosted production guard
  until #24 supplies identity/repo authorization, plus request limits,
  redaction, cwd allowlist, safe errors, and secret-safe artifacts before hosted
  production use.
- #24 GitHub App auth must implement auth-by-default and bind users/service
  tokens to installation, repo, PR, and permission claims for every run,
  artifact, browser mutation, and publish operation.
- #25 publishing must be idempotent, commit-bound, permission-checked, and safe
  for untrusted provider output.
- #26 CLI hosted commands must make upload boundaries explicit and must not
  reuse local-trusted `cwd` semantics for hosted execution.
- #27 and #28 Review Room must enforce server-side run authorization,
  CSRF/origin/CORS/session-cookie protections for browser mutations, and safe
  rendering before showing code, prompts, findings, comments, or artifacts.
- #29 provider policy must add model budget classes, allowlists, fallback
  rules, diagnostics, and telemetry without letting prompts select providers.
- #30 observability must record audit-quality security decisions without raw
  private payloads.
- #31 CI must gate generated contracts, supply chain policy, Rust parity,
  preview validation, and security-relevant environment configuration.
- #32 docs must keep this threat model, runtime specs, ADRs, and runbooks in
  sync with implemented behavior.
- #33 Ratatui TUI must remain a hosted-service client that uses generated
  contracts, scoped tokens, and server-side authorization; it must not embed a
  second local review engine or bypass hosted publish/cancel controls.
- #34 Tauri/desktop ADR must not bypass hosted authz, token storage, or IPC
  capability restrictions if desktop distribution is later approved.
- #35 launch signoff must dogfood authentication, authorization, redaction,
  rate limits, sandbox policy, provider budget policy, metadata mirrors, GitHub
  publishing, web rendering, accessibility, artifact handling, and deployment
  posture end to end.

## Explicit Non-Goals for This Issue

- No authentication or authorization implementation.
- No identity-bound durable ownership, permission, or security audit-field
  implementation.
- No sandbox execution integration into service.
- No GitHub App auth or publish implementation.
- No web UI implementation.
- No change to local-trusted CLI behavior.

## Open Assumptions for Later Issues

- GitHub identity and scoped service tokens are the production auth model.
- Postgres/Drizzle is the durable queryable service store for run, event, and
  artifact metadata.
- Identity-bound durable ownership and security audit rows must be added before
  hosted production authorization is accepted.
- Workflow is orchestration and replay infrastructure, not the queryable
  security ledger.
- Convex metadata mirroring remains optional and non-authoritative unless a
  later issue explicitly promotes or replaces it.
- Private code and prompts remain sensitive even when only derived summaries or
  findings are persisted.
- Hosted service production deployment is blocked until #23 and #24 close.
