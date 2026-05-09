# ADR-0003: Detached Execution and Fallback

- Status: Accepted
- Date: 2026-03-01

## Context

Service workloads can exceed synchronous HTTP tolerances. The platform requires detached review execution while keeping baseline operation possible without mandatory external workflow infrastructure.

## Decision

Use workflow-backed detached execution when available, with local asynchronous fallback when workflow API operations are unavailable.

- Primary path: `@workflow/core/runtime` `start(...)`
- Fallback path: local in-process async execution with in-memory state tracking
- Shared detached status model for both paths

## Consequences

### Positive

- Detached mode remains usable in local/dev environments
- Production can leverage durable workflow execution when configured
- Service API remains stable regardless of backend availability

### Negative

- In-memory fallback is non-durable across process restarts
- Dual-path behavior requires careful testing and documentation

## Alternatives Considered

- Workflow-only detached execution: rejected because it would make detached mode unavailable when workflow APIs are not configured.
