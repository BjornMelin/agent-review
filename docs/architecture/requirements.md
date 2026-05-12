# Architecture Requirements

Version: `0.1.0`

## Functional Requirements

### FR-1 Review Request Validation

- System shall validate incoming review requests against strict schema boundaries.
- Unknown keys at schema boundaries shall be rejected.
- Canonical contract lives in `ReviewRequestSchema`.

### FR-2 Review Target Support

System shall support review targets:

- `uncommittedChanges`
- `baseBranch` (with merge-base-aware diffing)
- `commit`
- `custom`

### FR-3 Provider Abstraction

System shall execute reviews through a provider interface with:

- Stable provider IDs (`codexDelegate`, `openaiCompatible`)
- Capability metadata
- A normalized run method returning raw payload + text
- Provider policy telemetry for successful policy-routed runs, including
  allowlisted model, fallback evidence, input/output/timeout budgets, retention
  metadata, and usage/latency data when reported by the upstream SDK

### FR-4 Artifact Generation

System shall output one or more of:

- `json`
- `markdown`
- `sarif`

Requested formats shall drive generated artifacts only.

### FR-5 Finding Location Integrity

Findings shall be validated against changed lines in collected diff context. Invalid line mappings shall fail execution with an explicit error.

### FR-6 Exit Code Semantics

- Without threshold: exit `1` when findings exist, else `0`.
- With threshold: exit `1` when findings at or above threshold exist, else `0`.
- CLI usage/config/auth/runtime errors shall map to non-zero operational codes.

### FR-7 Service API

Service shall expose endpoints for:

- Start review
- List review runs with repository and status filters
- Read review status
- Stream review lifecycle events (SSE)
- Cancel detached review
- Retrieve generated artifacts by format
- Read and update finding triage state
- Preview and publish completed review output to authorized GitHub targets

### FR-8 Detached Execution

System shall support detached review execution through workflow integration and
durable service state. If Workflow cannot accept a detached run, the service
shall persist the failed start state and return an error instead of reporting
local fallback success.

### FR-9 Runtime Control

System shall enforce bounded runtime admission through durable service records:

- active run leases with heartbeat and expiry timestamps
- global queued and live-leased active limits
- per-scope active-run limits based on canonicalized cwd and target identity
- retryable `429` backpressure responses for capacity exhaustion
- terminal failure for expired leases when reconciled

Cancellation shall propagate through available native runtime hooks and shall
only be reported as terminally successful after the runtime reports cancelled
state.

### FR-10 Optional Metadata Mirroring

When configured with `CONVEX_URL`, system shall attempt non-blocking metadata mirror writes for completed reviews.

### FR-11 Review Room Operations Surface

System shall expose a Review Room web surface that lets authorized operators:

- list hosted runs by status and repository context
- inspect run detail, metrics, lifecycle events, findings, and artifacts
- update finding triage state and notes through service-authorized route
  handlers
- preview and publish completed review output to GitHub
- cancel nonterminal hosted runs without exposing service bearer tokens to
  browser JavaScript

## Non-Functional Requirements

### NFR-1 Strict Typing and Validation

- TypeScript strict mode in shared base config
- Zod-backed runtime validation for core request/response boundaries

### NFR-2 Deterministic Ordering

Findings shall be sorted deterministically in outputs to improve reproducibility.

### NFR-3 Safe Sandbox Controls

Remote sandbox execution shall enforce:

- Command allowlist
- Network policy profile
- Environment key allowlist
- Wall-time and output budgets
- Basic secret redaction in command output
- Artifact byte budgets and redaction before persisted audit/result storage
- Sandbox ID propagation in run results and lifecycle/event correlation

### NFR-4 Operational Simplicity

- Single monorepo build/test/lint entrypoints
- No required external persistence for local baseline operation; production
  durable deployments require Postgres/Drizzle unless volatile memory is
  explicitly selected.
- Hosted service status/list surfaces expose redaction-safe run metrics for
  duration, queue time, provider usage, sandbox consumption, artifact bytes, and
  correlation without requiring operators to inspect raw logs.

### NFR-5 CI Compatibility

CI pipeline shall run named branch-protection lanes for static checks,
generated-contract drift/Rust DTO parity, Rust gates, TypeScript
typecheck/tests/builds, dependency security audit, and the stable `check`
aggregator on pull requests and pushes to main. Vercel preview smoke shall run
when a preview deployment signal is emitted.

### NFR-6 Hosted Review Security Gates

Hosted review service work shall satisfy the acceptance gates in
[`docs/architecture/security/threat-model.md`](./security/threat-model.md)
before production deployment.
