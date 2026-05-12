# ADR-0001: Runtime Topology

- Status: Accepted
- Date: 2026-03-01

## Amendment - 2026-05-12

The current topology also includes `apps/review-web` as the Next.js Review Room
operations surface. This ADR remains the original topology decision; the
canonical current application/package map is
[System Overview](../spec/system-overview.md).

## Context

The platform must support local developer workflows and service-based orchestration while sharing strict review contracts and avoiding duplicated core logic.

## Decision

Use a multi-app, shared-package monorepo topology:

- CLI app for direct local/CI usage
- Service app for HTTP orchestration and streaming
- Worker app for detached execution
- Web app for hosted Review Room operations
- Shared packages for schemas, core orchestration, providers, git diff, reporting, sandbox policy, and optional metadata mirroring

## Consequences

### Positive

- Single source of truth for schemas and review logic
- Reduced duplication across runtime surfaces
- Easier testing and refactoring of independent concerns

### Negative

- Additional package wiring and workspace coordination
- Higher up-front repository structure complexity

## Alternatives Considered

- Single binary/service codebase without package boundaries: rejected due to weaker contract reuse and lower modularity.
