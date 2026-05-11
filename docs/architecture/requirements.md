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
- Read review status
- Stream review lifecycle events (SSE)
- Cancel detached review
- Retrieve generated artifacts by format

### FR-8 Detached Execution

System shall support detached review execution through workflow integration with fallback to local asynchronous execution when workflow APIs are unavailable.

### FR-9 Optional Metadata Mirroring

When configured with `CONVEX_URL`, system shall attempt non-blocking metadata mirror writes for completed reviews.

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

### NFR-4 Operational Simplicity

- Single monorepo build/test/lint entrypoints
- No required external persistence for baseline operation

### NFR-5 CI Compatibility

CI pipeline shall run install, format check, lint, typecheck, test, and build on pull requests and pushes to main.

### NFR-6 Hosted Review Security Gates

Hosted review service work shall satisfy the acceptance gates in
[`docs/architecture/security/threat-model.md`](./security/threat-model.md)
before production deployment.
