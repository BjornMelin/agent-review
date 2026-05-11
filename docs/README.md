# Documentation Index

This directory contains canonical product and architecture documentation for the current implementation.

## Top-Level Docs

- [PRD](./PRD.md)
- [Architecture Requirements](./architecture/requirements.md)
- [Release Checklist](./release/release-checklist.md)

## Release Docs

- [One-Issue-One-PR Release Playbook](./release/one-issue-one-pr-playbook.md)
- [Dependency Modernization Ledger](./release/dependency-modernization-2026-05.md)

## Architecture Specifications

- [System Overview](./architecture/spec/system-overview.md)
- [CLI Contract](./architecture/spec/cli-contract.md)
- [Review Service API](./architecture/spec/review-service-api.md)
- [Schema and Provider Contracts](./architecture/spec/schema-and-provider-contracts.md)
- [Sandbox, Detached Execution, and Mirroring](./architecture/spec/sandbox-detached-and-mirroring.md)
- [Testing Strategy](./architecture/spec/testing-strategy.md)
- [Hosted Review Service Threat Model](./architecture/security/threat-model.md)

## Architecture Decision Records

- [ADR-0001 Runtime Topology](./architecture/adr/0001-runtime-topology.md)
- [ADR-0002 Provider Abstraction and Output Schema](./architecture/adr/0002-provider-abstraction-and-output-schema.md)
- [ADR-0003 Detached Execution and Fallback](./architecture/adr/0003-detached-execution-and-fallback.md)
- [ADR-0004 TypeScript Control Plane and Rust Helper Boundary](./architecture/adr/0004-typescript-control-plane-and-rust-helper-boundary.md)
- [ADR-0005 Durable Review Storage](./architecture/adr/0005-durable-review-storage.md)
- [ADR-0006 Durable Workflow Detached Execution](./architecture/adr/0006-durable-workflow-detached-execution.md)

## Source of Truth

Implementation contracts are defined in code and mirrored here:

- Shared schemas/types: `packages/review-types/src/index.ts`
- Rust contract DTO parity: `crates/review-contracts`
- Core orchestration: `packages/review-core/src/index.ts`
- Provider construction/model policy: `packages/review-provider-registry/src/index.ts`
- CLI surface: `apps/review-cli/src/index.ts`
- Service surface: `apps/review-service/src/app.ts` and runtime entrypoint:
  `apps/review-service/src/server.ts`
- Detached execution: `apps/review-worker/src/index.ts`
