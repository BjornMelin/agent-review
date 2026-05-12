import { createHash, randomUUID } from 'node:crypto';
import type { ReviewRunResult } from '@review-agent/review-core';
import {
  ARTIFACT_CONTENT_TYPES,
  type LifecycleEvent,
  type OutputFormat,
  type ReviewAuthPrincipal,
  type ReviewAuthScope,
  type ReviewRepositoryAuthorization,
  type ReviewRequest,
  type ReviewRunAuthorization,
  type ReviewRunLease,
  type ReviewRunStatus,
} from '@review-agent/review-types';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import {
  drizzle as drizzleNodePostgres,
  type NodePgDatabase,
} from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import pg, { type PoolConfig } from 'pg';
import * as schema from './schema.js';
import {
  authAuditEvents,
  githubInstallations,
  githubRepositories,
  githubRepositoryPermissions,
  githubUsers,
  reviewArtifacts,
  reviewEvents,
  reviewRuns,
  reviewStatusTransitions,
  serviceTokens,
} from './schema.js';

type ReviewStorageSchema = typeof schema;
type ReviewStorageDatabase =
  | NodePgDatabase<ReviewStorageSchema>
  | PgliteDatabase<ReviewStorageSchema>;
type ReviewRunRow = typeof reviewRuns.$inferSelect;
type ReviewEventRow = typeof reviewEvents.$inferSelect;
type ReviewArtifactRow = typeof reviewArtifacts.$inferSelect;
type ServiceTokenRow = typeof serviceTokens.$inferSelect;
type AuthAuditEventRow = typeof authAuditEvents.$inferSelect;
type CleanupCandidate = {
  reviewId: string;
  status: ReviewRunStatus;
  updatedAt: Date;
  retentionExpiresAt: Date | null;
};
type RuntimeCapacityRecord = Pick<
  ReviewRecord,
  'status' | 'lease' | 'detachedRunId' | 'updatedAt' | 'request'
>;

type SerializedReviewRunResult = Omit<ReviewRunResult, 'diff'> & {
  diff: Omit<ReviewRunResult['diff'], 'changedLineIndex'> & {
    changedLineIndex: Array<[string, number[]]>;
  };
};

/**
 * Defines the durable record shape persisted for each review run.
 */
export type ReviewRecord = {
  reviewId: string;
  status: ReviewRunStatus;
  request: ReviewRequest;
  authorization?: ReviewRunAuthorization;
  createdAt: number;
  updatedAt: number;
  result?: ReviewRunResult;
  error?: string;
  detachedRunId?: string;
  workflowRunId?: string;
  sandboxId?: string;
  lease?: ReviewRunLease;
  cancelRequestedAt?: number;
  retentionExpiresAt?: number;
  deletedAt?: number;
  events: LifecycleEvent[];
};

type ReviewRecordWithLease = ReviewRecord & { lease: ReviewRunLease };

/**
 * Stores a hashed automation token and the repository/scope boundary it grants.
 */
export type ServiceTokenRecord = {
  tokenId: string;
  tokenPrefix: string;
  tokenHash: string;
  name: string;
  scopes: ReviewAuthScope[];
  repository: ReviewRepositoryAuthorization;
  createdBy?: ReviewAuthPrincipal;
  expiresAt?: number;
  revokedAt?: number;
  lastUsedAt?: number;
  createdAt: number;
  updatedAt: number;
};

/**
 * Stores a GitHub user identity available for repository authorization.
 */
export type GitHubUserRecord = {
  githubUserId: string;
  login: string;
  name?: string;
  avatarUrl?: string;
  createdAt: number;
  updatedAt: number;
};

/**
 * Stores a GitHub App installation permission snapshot.
 */
export type GitHubInstallationRecord = {
  installationId: string;
  accountLogin: string;
  accountType: string;
  permissions: Record<string, string>;
  repositorySelection: string;
  suspendedAt?: number;
  createdAt: number;
  updatedAt: number;
};

/**
 * Stores a repository reachable through a GitHub App installation.
 */
export type GitHubRepositoryRecord = ReviewRepositoryAuthorization & {
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
};

/**
 * Stores a user-specific repository permission snapshot.
 */
export type GitHubRepositoryPermissionRecord = {
  githubUserId: string;
  repositoryId: string;
  permission: 'read' | 'write' | 'admin';
  updatedAt: number;
};

/**
 * Stores security audit rows for authn/authz decisions.
 */
export type AuthAuditEventRecord = {
  auditEventId: string;
  eventType: 'authn' | 'authz' | 'token';
  operation: string;
  result: 'allowed' | 'denied';
  reason: string;
  status: number;
  principal?: ReviewAuthPrincipal;
  tokenId?: string;
  tokenPrefix?: string;
  repository?: ReviewRepositoryAuthorization;
  reviewId?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
};

/**
 * Defines durable auth storage for GitHub identity, scoped tokens, and audit rows.
 */
export type ReviewAuthStoreAdapter = {
  getServiceToken(tokenId: string): Promise<ServiceTokenRecord | undefined>;
  setServiceToken(record: ServiceTokenRecord): Promise<void>;
  touchServiceToken(tokenId: string, lastUsedAt: number): Promise<void>;
  upsertGitHubUser(record: GitHubUserRecord): Promise<void>;
  upsertGitHubInstallation(record: GitHubInstallationRecord): Promise<void>;
  upsertGitHubRepository(record: GitHubRepositoryRecord): Promise<void>;
  upsertGitHubRepositoryPermission(
    record: GitHubRepositoryPermissionRecord
  ): Promise<void>;
  appendAuthAuditEvent(record: AuthAuditEventRecord): Promise<void>;
  listAuthAuditEvents(): Promise<AuthAuditEventRecord[]>;
};

/**
 * Carries optional audit context for store write operations.
 */
export type ReviewStoreWriteOptions = {
  reason?: string;
};

/**
 * Defines event-append options, including the retained replay window size.
 */
export type ReviewStoreAppendEventOptions = ReviewStoreWriteOptions & {
  maxEvents: number;
};

/**
 * Defines the logical clock input used by retention cleanup.
 */
export type ReviewStoreCleanupOptions = {
  nowMs: number;
};

/**
 * Defines capacity gates evaluated while reserving a new runtime lease.
 */
export type ReviewStoreRuntimeCapacityOptions = ReviewStoreWriteOptions & {
  nowMs: number;
  legacyUnleasedActiveTtlMs?: number;
  scopeKeyForRequest?: (request: ReviewRequest) => string;
  maxQueuedRuns: number;
  maxRunningRuns: number;
  maxActiveRunsPerScope: number;
};

/**
 * Describes whether a runtime reservation was accepted or why capacity rejected it.
 */
export type ReviewStoreRuntimeReservation =
  | { reserved: true }
  | { reserved: false; reason: 'queue' | 'running' | 'scope'; message: string };

/**
 * Defines durable review storage for runs, lifecycle events, and artifact metadata.
 */
export type ReviewStoreAdapter = {
  get(reviewId: string): Promise<ReviewRecord | undefined>;
  reserve(
    record: ReviewRecordWithLease,
    options: ReviewStoreRuntimeCapacityOptions
  ): Promise<ReviewStoreRuntimeReservation>;
  set(record: ReviewRecord, options?: ReviewStoreWriteOptions): Promise<void>;
  appendEvent(
    record: ReviewRecord,
    event: LifecycleEvent,
    options: ReviewStoreAppendEventOptions
  ): Promise<void>;
  delete(reviewId: string): Promise<void>;
  cleanup(options: ReviewStoreCleanupOptions): Promise<string[]>;
  entries(): Promise<Array<[string, ReviewRecord]>>;
  size(): Promise<number>;
};

/**
 * Extends a review store with explicit resource cleanup for pooled backends.
 */
export type ClosableReviewStore = ReviewStoreAdapter & {
  close(): Promise<void>;
};

function cloneReviewRunResult(result: ReviewRunResult): ReviewRunResult {
  const cloned: ReviewRunResult = {
    ...result,
    artifacts: { ...result.artifacts },
    diff: {
      ...result.diff,
      chunks: result.diff.chunks.map((chunk) => ({ ...chunk })),
      changedLineIndex: new Map(
        [...result.diff.changedLineIndex.entries()].map(([file, lines]) => [
          file,
          new Set(lines),
        ])
      ),
    },
    result: {
      ...result.result,
      findings: result.result.findings.map((finding) => ({
        ...finding,
        codeLocation: {
          ...finding.codeLocation,
          lineRange: { ...finding.codeLocation.lineRange },
        },
      })),
      metadata: {
        ...result.result.metadata,
        gitContext: { ...result.result.metadata.gitContext },
      },
    },
  };
  if (result.sandboxAudit) {
    cloned.sandboxAudit = structuredClone(result.sandboxAudit);
  }
  return cloned;
}

function cloneLifecycleEvent(event: LifecycleEvent): LifecycleEvent {
  return {
    ...event,
    meta: {
      ...event.meta,
      correlation: { ...event.meta.correlation },
    },
  };
}

function cloneRecord(record: ReviewRecord): ReviewRecord {
  const next: ReviewRecord = {
    reviewId: record.reviewId,
    status: record.status,
    request: structuredClone(record.request),
    ...(record.authorization
      ? { authorization: structuredClone(record.authorization) }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    events: record.events.map(cloneLifecycleEvent),
  };
  if (record.result) {
    next.result = cloneReviewRunResult(record.result);
  }
  if (record.error) {
    next.error = record.error;
  }
  if (record.detachedRunId) {
    next.detachedRunId = record.detachedRunId;
  }
  if (record.workflowRunId) {
    next.workflowRunId = record.workflowRunId;
  }
  if (record.sandboxId) {
    next.sandboxId = record.sandboxId;
  }
  if (record.lease) {
    next.lease = { ...record.lease };
  }
  if (record.cancelRequestedAt !== undefined) {
    next.cancelRequestedAt = record.cancelRequestedAt;
  }
  if (record.retentionExpiresAt !== undefined) {
    next.retentionExpiresAt = record.retentionExpiresAt;
  }
  if (record.deletedAt !== undefined) {
    next.deletedAt = record.deletedAt;
  }
  return next;
}

function assertReviewRecordWithLease(
  record: ReviewRecord
): asserts record is ReviewRecordWithLease {
  if (!record.lease) {
    throw new Error('runtime reservation requires a lease');
  }
}

function serializeReviewRunResult(
  result: ReviewRunResult
): SerializedReviewRunResult {
  return {
    ...result,
    artifacts: {},
    diff: {
      ...result.diff,
      chunks: result.diff.chunks.map((chunk) => ({ ...chunk })),
      changedLineIndex: [...result.diff.changedLineIndex.entries()].map(
        ([file, lines]) => [file, [...lines]]
      ),
    },
  };
}

function deserializeReviewRunResult(
  input: unknown
): ReviewRunResult | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const stored = input as SerializedReviewRunResult;
  return {
    ...stored,
    artifacts: { ...stored.artifacts },
    diff: {
      ...stored.diff,
      chunks: stored.diff.chunks.map((chunk) => ({ ...chunk })),
      changedLineIndex: new Map(
        stored.diff.changedLineIndex.map(([file, lines]) => [
          file,
          new Set(lines),
        ])
      ),
    },
  };
}

function buildRequestSummary(
  request: ReviewRequest
): ReviewRunRow['requestSummary'] {
  return {
    provider: request.provider,
    executionMode: request.executionMode,
    targetType: request.target.type,
    outputFormats: request.outputFormats,
  };
}

function dateFromMs(value: number | undefined): Date | null {
  return value === undefined ? null : new Date(value);
}

function msFromDate(value: Date | null): number | undefined {
  return value ? value.getTime() : undefined;
}

function artifactRowsFor(
  record: ReviewRecord
): Array<typeof reviewArtifacts.$inferInsert> {
  if (!record.result) {
    return [];
  }

  return Object.entries(record.result.artifacts).flatMap(
    ([format, content]) => {
      if (!content) {
        return [];
      }
      const outputFormat = format as OutputFormat;
      const artifactId = `${record.reviewId}:${outputFormat}`;
      const contentType = ARTIFACT_CONTENT_TYPES[outputFormat];
      return [
        {
          artifactId,
          reviewId: record.reviewId,
          format: outputFormat,
          contentType,
          byteLength: Buffer.byteLength(content),
          sha256: createHash('sha256').update(content).digest('hex'),
          storageKey: `postgres://review_artifacts/${record.reviewId}/${outputFormat}`,
          content,
          createdAt: new Date(record.updatedAt),
        },
      ];
    }
  );
}

function authPrincipalId(principal: ReviewAuthPrincipal): string {
  return principal.type === 'githubUser'
    ? String(principal.githubUserId)
    : principal.tokenId;
}

function runInsertFor(record: ReviewRecord): typeof reviewRuns.$inferInsert {
  const authorization = record.authorization;
  return {
    reviewId: record.reviewId,
    runId: record.detachedRunId ?? record.reviewId,
    status: record.status,
    request: record.request,
    authorization: authorization ?? null,
    requestSummary: buildRequestSummary(record.request),
    result: record.result ? serializeReviewRunResult(record.result) : null,
    error: record.error ?? null,
    detachedRunId: record.detachedRunId ?? null,
    workflowRunId: record.workflowRunId ?? record.detachedRunId ?? null,
    sandboxId: record.sandboxId ?? null,
    authActorType: authorization?.principal.type ?? null,
    authActorId: authorization
      ? authPrincipalId(authorization.principal)
      : null,
    githubInstallationId: authorization
      ? String(authorization.repository.installationId)
      : null,
    githubRepositoryId: authorization
      ? String(authorization.repository.repositoryId)
      : null,
    githubOwner: authorization?.repository.owner ?? null,
    githubRepo: authorization?.repository.name ?? null,
    requestHash: authorization?.requestHash ?? null,
    leaseOwner: record.lease?.owner ?? null,
    leaseScopeKey: record.lease?.scopeKey ?? null,
    leaseAcquiredAt: dateFromMs(record.lease?.acquiredAt),
    leaseHeartbeatAt: dateFromMs(record.lease?.heartbeatAt),
    leaseExpiresAt: dateFromMs(record.lease?.expiresAt),
    cancelRequestedAt: dateFromMs(record.cancelRequestedAt),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    completedAt: isTerminalStatus(record.status)
      ? new Date(record.updatedAt)
      : null,
    retentionExpiresAt: dateFromMs(record.retentionExpiresAt),
    deletedAt: dateFromMs(record.deletedAt),
  };
}

function isTerminalStatus(status: ReviewRunStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

function applyPersistedEvents(
  target: ReviewRecord,
  persisted: ReviewRecord
): void {
  target.events = persisted.events.map(cloneLifecycleEvent);
}

/**
 * Creates a deterministic in-memory adapter for local tests and no-database development.
 *
 * @returns A copy-on-read review store with the same async contract as Postgres.
 */
export function createInMemoryReviewStore(): ReviewStoreAdapter {
  const records = new Map<string, ReviewRecord>();
  let reserveLock = Promise.resolve();

  async function withReserveLock<T>(
    callback: () => T | Promise<T>
  ): Promise<T> {
    const previous = reserveLock;
    let releaseLock: () => void = () => undefined;
    reserveLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      releaseLock();
    }
  }

  return {
    async get(reviewId) {
      const record = records.get(reviewId);
      return record ? cloneRecord(record) : undefined;
    },
    async reserve(record, options) {
      assertReviewRecordWithLease(record);
      return await withReserveLock(() => {
        const reservation = runtimeReservationFor(
          [...records.values()],
          record.lease.scopeKey,
          options
        );
        if (!reservation.reserved) {
          return reservation;
        }
        records.set(record.reviewId, cloneRecord(record));
        return reservation;
      });
    },
    async set(record) {
      const existing = records.get(record.reviewId);
      if (existing && isTerminalStatus(existing.status)) {
        return;
      }
      const next = cloneRecord(record);
      if (existing) {
        const eventIds = new Set(
          existing.events.map((event) => event.meta.eventId)
        );
        next.events = [
          ...existing.events.map(cloneLifecycleEvent),
          ...next.events.filter((event) => !eventIds.has(event.meta.eventId)),
        ];
      }
      records.set(record.reviewId, next);
    },
    async appendEvent(record, event, options) {
      const existing = records.get(record.reviewId);
      if (existing && isTerminalStatus(existing.status)) {
        applyPersistedEvents(record, existing);
        return;
      }
      const next = existing ? cloneRecord(existing) : cloneRecord(record);
      if (
        !next.events.some((item) => item.meta.eventId === event.meta.eventId)
      ) {
        next.events.push(cloneLifecycleEvent(event));
      }
      next.events = next.events.slice(-options.maxEvents);
      records.set(next.reviewId, cloneRecord(next));
      applyPersistedEvents(record, next);
    },
    async delete(reviewId) {
      records.delete(reviewId);
    },
    async cleanup(options) {
      const rows = [...records.values()].map((record) => ({
        reviewId: record.reviewId,
        status: record.status,
        updatedAt: new Date(record.updatedAt),
        retentionExpiresAt: dateFromMs(record.retentionExpiresAt),
      }));
      const reviewIds = cleanupReviewIdsForRows(rows, options);
      for (const reviewId of reviewIds) {
        records.delete(reviewId);
      }
      return reviewIds;
    },
    async entries() {
      return [...records.entries()].map(([reviewId, record]) => [
        reviewId,
        cloneRecord(record),
      ]);
    },
    async size() {
      return records.size;
    },
  };
}

function cloneServiceTokenRecord(
  record: ServiceTokenRecord
): ServiceTokenRecord {
  return structuredClone(record);
}

function cloneAuthAuditEventRecord(
  record: AuthAuditEventRecord
): AuthAuditEventRecord {
  return structuredClone(record);
}

/**
 * Creates an in-memory auth store for local tests and no-database development.
 *
 * @returns A copy-on-read auth store with the same async contract as Postgres.
 */
export function createInMemoryReviewAuthStore(): ReviewAuthStoreAdapter {
  const tokens = new Map<string, ServiceTokenRecord>();
  const users = new Map<string, GitHubUserRecord>();
  const installations = new Map<string, GitHubInstallationRecord>();
  const repositories = new Map<string, GitHubRepositoryRecord>();
  const permissions = new Map<string, GitHubRepositoryPermissionRecord>();
  const auditEvents: AuthAuditEventRecord[] = [];

  return {
    async getServiceToken(tokenId) {
      const record = tokens.get(tokenId);
      return record ? cloneServiceTokenRecord(record) : undefined;
    },
    async setServiceToken(record) {
      tokens.set(record.tokenId, cloneServiceTokenRecord(record));
    },
    async touchServiceToken(tokenId, lastUsedAt) {
      const record = tokens.get(tokenId);
      if (!record) {
        return;
      }
      tokens.set(tokenId, {
        ...record,
        lastUsedAt,
        updatedAt: Math.max(record.updatedAt, lastUsedAt),
      });
    },
    async upsertGitHubUser(record) {
      users.set(record.githubUserId, structuredClone(record));
    },
    async upsertGitHubInstallation(record) {
      installations.set(record.installationId, structuredClone(record));
    },
    async upsertGitHubRepository(record) {
      repositories.set(String(record.repositoryId), structuredClone(record));
    },
    async upsertGitHubRepositoryPermission(record) {
      permissions.set(
        `${record.githubUserId}:${record.repositoryId}`,
        structuredClone(record)
      );
    },
    async appendAuthAuditEvent(record) {
      auditEvents.push(cloneAuthAuditEventRecord(record));
    },
    async listAuthAuditEvents() {
      return auditEvents.map(cloneAuthAuditEventRecord);
    },
  };
}

function buildRecord(
  run: ReviewRunRow,
  events: ReviewEventRow[],
  artifacts: ReviewArtifactRow[]
): ReviewRecord {
  const result = deserializeReviewRunResult(run.result);
  if (result) {
    for (const artifact of artifacts) {
      result.artifacts[artifact.format] = artifact.content;
    }
  }

  const record: ReviewRecord = {
    reviewId: run.reviewId,
    status: run.status,
    request: run.request,
    ...(run.authorization ? { authorization: run.authorization } : {}),
    createdAt: run.createdAt.getTime(),
    updatedAt: run.updatedAt.getTime(),
    events: events.map((row) => row.event),
  };
  if (result) {
    record.result = result;
  }
  if (run.error) {
    record.error = run.error;
  }
  if (run.detachedRunId) {
    record.detachedRunId = run.detachedRunId;
  }
  if (run.workflowRunId) {
    record.workflowRunId = run.workflowRunId;
  }
  if (run.sandboxId) {
    record.sandboxId = run.sandboxId;
  }
  const leaseAcquiredAt = msFromDate(run.leaseAcquiredAt);
  const leaseHeartbeatAt = msFromDate(run.leaseHeartbeatAt);
  const leaseExpiresAt = msFromDate(run.leaseExpiresAt);
  if (
    run.leaseOwner &&
    run.leaseScopeKey &&
    leaseAcquiredAt !== undefined &&
    leaseHeartbeatAt !== undefined &&
    leaseExpiresAt !== undefined
  ) {
    record.lease = {
      owner: run.leaseOwner,
      scopeKey: run.leaseScopeKey,
      acquiredAt: leaseAcquiredAt,
      heartbeatAt: leaseHeartbeatAt,
      expiresAt: leaseExpiresAt,
    };
  }
  const cancelRequestedAt = msFromDate(run.cancelRequestedAt);
  if (cancelRequestedAt !== undefined) {
    record.cancelRequestedAt = cancelRequestedAt;
  }
  const retentionExpiresAt = msFromDate(run.retentionExpiresAt);
  if (retentionExpiresAt !== undefined) {
    record.retentionExpiresAt = retentionExpiresAt;
  }
  const deletedAt = msFromDate(run.deletedAt);
  if (deletedAt !== undefined) {
    record.deletedAt = deletedAt;
  }
  return record;
}

function rowUpdateFor(
  record: ReviewRecord
): Partial<typeof reviewRuns.$inferInsert> {
  const insert = runInsertFor(record);
  return {
    runId: insert.runId,
    status: insert.status,
    request: insert.request,
    authorization: insert.authorization,
    requestSummary: insert.requestSummary,
    result: insert.result,
    error: insert.error,
    detachedRunId: insert.detachedRunId,
    workflowRunId: insert.workflowRunId,
    sandboxId: insert.sandboxId,
    authActorType: insert.authActorType,
    authActorId: insert.authActorId,
    githubInstallationId: insert.githubInstallationId,
    githubRepositoryId: insert.githubRepositoryId,
    githubOwner: insert.githubOwner,
    githubRepo: insert.githubRepo,
    requestHash: insert.requestHash,
    leaseOwner: insert.leaseOwner,
    leaseScopeKey: insert.leaseScopeKey,
    leaseAcquiredAt: insert.leaseAcquiredAt,
    leaseHeartbeatAt: insert.leaseHeartbeatAt,
    leaseExpiresAt: insert.leaseExpiresAt,
    cancelRequestedAt: insert.cancelRequestedAt,
    updatedAt: insert.updatedAt,
    completedAt: insert.completedAt,
    retentionExpiresAt: insert.retentionExpiresAt,
    deletedAt: insert.deletedAt,
  };
}

function transitionRow(
  reviewId: string,
  fromStatus: ReviewRunStatus | null,
  toStatus: ReviewRunStatus,
  reason: string,
  createdAtMs: number
): typeof reviewStatusTransitions.$inferInsert {
  return {
    transitionId: randomUUID(),
    reviewId,
    fromStatus,
    toStatus,
    reason,
    createdAt: new Date(createdAtMs),
  };
}

function cleanupReviewIdsForRows(
  rows: CleanupCandidate[],
  options: ReviewStoreCleanupOptions
): string[] {
  const deletedReviewIds = new Set<string>();
  for (const row of rows) {
    if (!isTerminalStatus(row.status)) {
      continue;
    }
    const explicitExpiryMs = msFromDate(row.retentionExpiresAt);
    if (explicitExpiryMs !== undefined && explicitExpiryMs <= options.nowMs) {
      deletedReviewIds.add(row.reviewId);
    }
  }

  return [...deletedReviewIds];
}

function isActiveForRuntimeCapacity(
  record: Pick<ReviewRecord, 'status' | 'lease' | 'updatedAt'>,
  options: ReviewStoreRuntimeCapacityOptions
): boolean {
  if (isTerminalStatus(record.status)) {
    return false;
  }
  if (record.lease) {
    return true;
  }
  if (record.status !== 'queued' && record.status !== 'running') {
    return false;
  }
  const ttlMs = options.legacyUnleasedActiveTtlMs;
  return ttlMs === undefined || record.updatedAt + ttlMs > options.nowMs;
}

function runtimeReservationFor(
  records: RuntimeCapacityRecord[],
  scopeKey: string,
  options: ReviewStoreRuntimeCapacityOptions
): ReviewStoreRuntimeReservation {
  let queued = 0;
  let running = 0;
  let scopedActive = 0;
  for (const record of records) {
    if (!isActiveForRuntimeCapacity(record, options)) {
      continue;
    }
    if (record.status === 'queued') {
      queued += 1;
    }
    if (isRuntimeExecutionCapacityRecord(record)) {
      running += 1;
    }
    if (isScopedCapacityRecord(record)) {
      const recordScopeKey =
        record.lease?.scopeKey ?? options.scopeKeyForRequest?.(record.request);
      if (recordScopeKey === scopeKey) {
        scopedActive += 1;
      }
    }
  }
  if (queued >= options.maxQueuedRuns) {
    return {
      reserved: false,
      reason: 'queue',
      message: 'review queue is at capacity',
    };
  }
  if (running >= options.maxRunningRuns) {
    return {
      reserved: false,
      reason: 'running',
      message: 'review runtime concurrency is at capacity',
    };
  }
  if (scopedActive >= options.maxActiveRunsPerScope) {
    return {
      reserved: false,
      reason: 'scope',
      message: 'review runtime scope is at capacity',
    };
  }
  return { reserved: true };
}

function isRuntimeExecutionCapacityRecord(
  record: RuntimeCapacityRecord
): boolean {
  return record.status === 'running' || Boolean(record.detachedRunId);
}

function isScopedCapacityRecord(record: RuntimeCapacityRecord): boolean {
  return (
    record.status === 'running' ||
    Boolean(record.lease) ||
    Boolean(record.detachedRunId)
  );
}

function capacityRecordForRunRow(run: ReviewRunRow): RuntimeCapacityRecord {
  const leaseAcquiredAt = msFromDate(run.leaseAcquiredAt);
  const leaseHeartbeatAt = msFromDate(run.leaseHeartbeatAt);
  const leaseExpiresAt = msFromDate(run.leaseExpiresAt);
  return {
    status: run.status,
    request: run.request,
    updatedAt: run.updatedAt.getTime(),
    ...(run.detachedRunId ? { detachedRunId: run.detachedRunId } : {}),
    ...(run.leaseOwner &&
    run.leaseScopeKey &&
    leaseAcquiredAt !== undefined &&
    leaseHeartbeatAt !== undefined &&
    leaseExpiresAt !== undefined
      ? {
          lease: {
            owner: run.leaseOwner,
            scopeKey: run.leaseScopeKey,
            acquiredAt: leaseAcquiredAt,
            heartbeatAt: leaseHeartbeatAt,
            expiresAt: leaseExpiresAt,
          },
        }
      : {}),
  };
}

/**
 * Creates a Drizzle-backed durable store for PostgreSQL-compatible databases.
 *
 * @param db - Drizzle PostgreSQL database connected with the review storage schema.
 * @returns A durable review store using transactional run, event, and artifact writes.
 */
export function createDrizzleReviewStore(
  db: ReviewStorageDatabase
): ReviewStoreAdapter {
  async function hydrate(reviewId: string): Promise<ReviewRecord | undefined> {
    const [run] = await db
      .select()
      .from(reviewRuns)
      .where(eq(reviewRuns.reviewId, reviewId));
    if (!run) {
      return undefined;
    }
    const [events, artifacts] = await Promise.all([
      db
        .select()
        .from(reviewEvents)
        .where(eq(reviewEvents.reviewId, reviewId))
        .orderBy(asc(reviewEvents.sequence)),
      db
        .select()
        .from(reviewArtifacts)
        .where(eq(reviewArtifacts.reviewId, reviewId)),
    ]);
    return buildRecord(run, events, artifacts);
  }

  async function persist(record: ReviewRecord, reason: string): Promise<void> {
    await db.transaction(
      async (tx) => {
        const [inserted] = await tx
          .insert(reviewRuns)
          .values(runInsertFor(record))
          .onConflictDoNothing()
          .returning();
        const existing = inserted
          ? undefined
          : await (async () => {
              await tx.execute(sql`
                SELECT ${reviewRuns.reviewId}
                FROM ${reviewRuns}
                WHERE ${reviewRuns.reviewId} = ${record.reviewId}
                FOR UPDATE
              `);
              const [row] = await tx
                .select({ status: reviewRuns.status })
                .from(reviewRuns)
                .where(eq(reviewRuns.reviewId, record.reviewId));
              if (row && isTerminalStatus(row.status)) {
                return row;
              }
              await tx
                .update(reviewRuns)
                .set(rowUpdateFor(record))
                .where(eq(reviewRuns.reviewId, record.reviewId));
              return row;
            })();
        if (existing && isTerminalStatus(existing.status)) {
          return;
        }
        if (inserted && record.events.length > 0) {
          await tx.execute(sql`
            SELECT ${reviewRuns.reviewId}
            FROM ${reviewRuns}
            WHERE ${reviewRuns.reviewId} = ${record.reviewId}
            FOR UPDATE
          `);
        }

        if (inserted || existing?.status !== record.status) {
          await tx
            .insert(reviewStatusTransitions)
            .values(
              transitionRow(
                record.reviewId,
                existing?.status ?? null,
                record.status,
                reason,
                record.updatedAt
              )
            );
        }

        for (const event of record.events) {
          await tx.execute(sql`
            WITH locked_run AS (
              SELECT ${reviewRuns.reviewId}
              FROM ${reviewRuns}
              WHERE ${reviewRuns.reviewId} = ${record.reviewId}
              FOR UPDATE
            ),
            next_sequence AS (
              UPDATE ${reviewRuns}
              SET event_sequence = ${reviewRuns.eventSequence} + 1
              FROM locked_run
              WHERE ${reviewRuns.reviewId} = locked_run.review_id
                AND NOT EXISTS (
                  SELECT 1
                  FROM ${reviewEvents}
                  WHERE ${reviewEvents.eventId} = ${event.meta.eventId}
                )
              RETURNING ${reviewRuns.eventSequence}
            )
            INSERT INTO ${reviewEvents} (
              review_id,
              event_id,
              sequence,
              event,
              created_at
            )
            SELECT
              ${record.reviewId},
              ${event.meta.eventId},
              next_sequence.event_sequence,
              ${JSON.stringify(cloneLifecycleEvent(event))}::jsonb,
              ${new Date(event.meta.timestampMs)}
            FROM next_sequence
            ON CONFLICT (event_id) DO NOTHING
          `);
        }

        if (record.result) {
          await tx
            .delete(reviewArtifacts)
            .where(eq(reviewArtifacts.reviewId, record.reviewId));
          const artifacts = artifactRowsFor(record);
          if (artifacts.length > 0) {
            await tx.insert(reviewArtifacts).values(artifacts);
          }
        }
      },
      { isolationLevel: 'read committed' }
    );
  }

  return {
    get(reviewId) {
      return hydrate(reviewId);
    },
    async reserve(record, options) {
      assertReviewRecordWithLease(record);
      return db.transaction(
        async (tx) => {
          await tx.execute(
            sql.raw('LOCK TABLE review_runs IN SHARE ROW EXCLUSIVE MODE')
          );
          const rows = await tx
            .select()
            .from(reviewRuns)
            .where(inArray(reviewRuns.status, ['queued', 'running']));
          const reservation = runtimeReservationFor(
            rows.map(capacityRecordForRunRow),
            record.lease.scopeKey,
            options
          );
          if (!reservation.reserved) {
            return reservation;
          }

          await tx.insert(reviewRuns).values(runInsertFor(record));
          await tx
            .insert(reviewStatusTransitions)
            .values(
              transitionRow(
                record.reviewId,
                null,
                record.status,
                options.reason ?? 'runtime reserved',
                record.updatedAt
              )
            );
          return reservation;
        },
        { isolationLevel: 'read committed' }
      );
    },
    async set(record, options = {}) {
      await persist(record, options.reason ?? 'record set');
    },
    async appendEvent(record, event, options) {
      await db.transaction(
        async (tx) => {
          const [inserted] = await tx
            .insert(reviewRuns)
            .values(runInsertFor(record))
            .onConflictDoNothing()
            .returning();

          if (inserted) {
            await tx
              .insert(reviewStatusTransitions)
              .values(
                transitionRow(
                  record.reviewId,
                  null,
                  record.status,
                  options.reason ?? 'event append',
                  record.updatedAt
                )
              );
          } else {
            await tx.execute(sql`
              SELECT ${reviewRuns.reviewId}
              FROM ${reviewRuns}
              WHERE ${reviewRuns.reviewId} = ${record.reviewId}
              FOR UPDATE
            `);
            const [row] = await tx
              .select({ status: reviewRuns.status })
              .from(reviewRuns)
              .where(eq(reviewRuns.reviewId, record.reviewId));
            if (row && isTerminalStatus(row.status)) {
              return;
            }
          }

          await tx.execute(sql`
            WITH locked_run AS (
              SELECT ${reviewRuns.reviewId}
              FROM ${reviewRuns}
              WHERE ${reviewRuns.reviewId} = ${record.reviewId}
              FOR UPDATE
            ),
            next_sequence AS (
              UPDATE ${reviewRuns}
              SET event_sequence = ${reviewRuns.eventSequence} + 1
              FROM locked_run
              WHERE ${reviewRuns.reviewId} = locked_run.review_id
                AND NOT EXISTS (
                  SELECT 1
                  FROM ${reviewEvents}
                  WHERE ${reviewEvents.eventId} = ${event.meta.eventId}
                )
              RETURNING ${reviewRuns.eventSequence}
            )
            INSERT INTO ${reviewEvents} (
              review_id,
              event_id,
              sequence,
              event,
              created_at
            )
            SELECT
              ${record.reviewId},
              ${event.meta.eventId},
              next_sequence.event_sequence,
              ${JSON.stringify(cloneLifecycleEvent(event))}::jsonb,
              ${new Date(event.meta.timestampMs)}
            FROM next_sequence
            ON CONFLICT (event_id) DO NOTHING
          `);

          const retainedEvents = await tx
            .select({ sequence: reviewEvents.sequence })
            .from(reviewEvents)
            .where(eq(reviewEvents.reviewId, record.reviewId))
            .orderBy(asc(reviewEvents.sequence));
          const overflowCount = retainedEvents.length - options.maxEvents;
          if (overflowCount > 0) {
            await tx.delete(reviewEvents).where(
              and(
                eq(reviewEvents.reviewId, record.reviewId),
                inArray(
                  reviewEvents.sequence,
                  retainedEvents
                    .slice(0, overflowCount)
                    .map((row) => row.sequence)
                )
              )
            );
          }
        },
        { isolationLevel: 'read committed' }
      );
      const persisted = await hydrate(record.reviewId);
      if (persisted) {
        applyPersistedEvents(record, persisted);
      }
    },
    async delete(reviewId) {
      await db.delete(reviewRuns).where(eq(reviewRuns.reviewId, reviewId));
    },
    async cleanup(options) {
      const rows = await db
        .select({
          reviewId: reviewRuns.reviewId,
          status: reviewRuns.status,
          updatedAt: reviewRuns.updatedAt,
          retentionExpiresAt: reviewRuns.retentionExpiresAt,
        })
        .from(reviewRuns)
        .orderBy(asc(reviewRuns.updatedAt));
      const reviewIds = cleanupReviewIdsForRows(rows, options);
      await deleteReviewsById(db, reviewIds);
      return reviewIds;
    },
    async entries() {
      const runs = await db
        .select({ reviewId: reviewRuns.reviewId })
        .from(reviewRuns)
        .orderBy(asc(reviewRuns.updatedAt));
      const records = await Promise.all(
        runs.map(async ({ reviewId }) => {
          const record = await hydrate(reviewId);
          return record ? ([reviewId, record] as [string, ReviewRecord]) : null;
        })
      );
      return records.filter((record): record is [string, ReviewRecord] =>
        Boolean(record)
      );
    },
    async size() {
      const [row] = await db.select({ value: count() }).from(reviewRuns);
      return row?.value ?? 0;
    },
  };
}

function serviceTokenRecordFromRow(row: ServiceTokenRow): ServiceTokenRecord {
  const expiresAt = msFromDate(row.expiresAt);
  const revokedAt = msFromDate(row.revokedAt);
  const lastUsedAt = msFromDate(row.lastUsedAt);
  return {
    tokenId: row.tokenId,
    tokenPrefix: row.tokenPrefix,
    tokenHash: row.tokenHash,
    name: row.name,
    scopes: row.scopes,
    repository: row.repository,
    ...(row.createdBy ? { createdBy: row.createdBy } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(revokedAt !== undefined ? { revokedAt } : {}),
    ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function authAuditEventRecordFromRow(
  row: AuthAuditEventRow
): AuthAuditEventRecord {
  return {
    auditEventId: row.auditEventId,
    eventType: row.eventType as AuthAuditEventRecord['eventType'],
    operation: row.operation,
    result: row.result as AuthAuditEventRecord['result'],
    reason: row.reason,
    status: row.status,
    ...(row.principal ? { principal: row.principal } : {}),
    ...(row.tokenId ? { tokenId: row.tokenId } : {}),
    ...(row.tokenPrefix ? { tokenPrefix: row.tokenPrefix } : {}),
    ...(row.repository ? { repository: row.repository } : {}),
    ...(row.reviewId ? { reviewId: row.reviewId } : {}),
    ...(row.requestId ? { requestId: row.requestId } : {}),
    ...(row.metadata ? { metadata: row.metadata } : {}),
    createdAt: row.createdAt.getTime(),
  };
}

function githubUserValues(
  record: GitHubUserRecord
): typeof githubUsers.$inferInsert {
  return {
    githubUserId: record.githubUserId,
    login: record.login,
    name: record.name ?? null,
    avatarUrl: record.avatarUrl ?? null,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

function githubInstallationValues(
  record: GitHubInstallationRecord
): typeof githubInstallations.$inferInsert {
  return {
    installationId: record.installationId,
    accountLogin: record.accountLogin,
    accountType: record.accountType,
    permissions: record.permissions,
    repositorySelection: record.repositorySelection,
    suspendedAt: dateFromMs(record.suspendedAt),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

function githubRepositoryValues(
  record: GitHubRepositoryRecord
): typeof githubRepositories.$inferInsert {
  return {
    repositoryId: String(record.repositoryId),
    installationId: String(record.installationId),
    owner: record.owner,
    name: record.name,
    fullName: record.fullName,
    visibility: record.visibility,
    permissions: record.permissions,
    deletedAt: dateFromMs(record.deletedAt),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

function serviceTokenValues(
  record: ServiceTokenRecord
): typeof serviceTokens.$inferInsert {
  return {
    tokenId: record.tokenId,
    tokenPrefix: record.tokenPrefix,
    tokenHash: record.tokenHash,
    name: record.name,
    scopes: record.scopes,
    repository: record.repository,
    createdBy: record.createdBy ?? null,
    expiresAt: dateFromMs(record.expiresAt),
    revokedAt: dateFromMs(record.revokedAt),
    lastUsedAt: dateFromMs(record.lastUsedAt),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

function authAuditEventValues(
  record: AuthAuditEventRecord
): typeof authAuditEvents.$inferInsert {
  return {
    auditEventId: record.auditEventId,
    eventType: record.eventType,
    operation: record.operation,
    result: record.result,
    reason: record.reason,
    status: record.status,
    principal: record.principal ?? null,
    tokenId: record.tokenId ?? null,
    tokenPrefix: record.tokenPrefix ?? null,
    repository: record.repository ?? null,
    reviewId: record.reviewId ?? null,
    requestId: record.requestId ?? null,
    metadata: record.metadata ?? null,
    createdAt: new Date(record.createdAt),
  };
}

/**
 * Creates a Drizzle-backed auth store for PostgreSQL-compatible databases.
 *
 * @param db - Drizzle PostgreSQL database connected with the review storage schema.
 * @returns A durable auth store for GitHub identity, service tokens, and audit rows.
 */
export function createDrizzleReviewAuthStore(
  db: ReviewStorageDatabase
): ReviewAuthStoreAdapter {
  return {
    async getServiceToken(tokenId) {
      const [row] = await db
        .select()
        .from(serviceTokens)
        .where(eq(serviceTokens.tokenId, tokenId));
      return row ? serviceTokenRecordFromRow(row) : undefined;
    },
    async setServiceToken(record) {
      const values = serviceTokenValues(record);
      await db
        .insert(serviceTokens)
        .values(values)
        .onConflictDoUpdate({
          target: serviceTokens.tokenId,
          set: {
            tokenPrefix: values.tokenPrefix,
            tokenHash: values.tokenHash,
            name: values.name,
            scopes: values.scopes,
            repository: values.repository,
            createdBy: values.createdBy,
            expiresAt: values.expiresAt,
            revokedAt: values.revokedAt,
            lastUsedAt: values.lastUsedAt,
            updatedAt: values.updatedAt,
          },
        });
    },
    async touchServiceToken(tokenId, lastUsedAt) {
      await db
        .update(serviceTokens)
        .set({
          lastUsedAt: new Date(lastUsedAt),
          updatedAt: new Date(lastUsedAt),
        })
        .where(eq(serviceTokens.tokenId, tokenId));
    },
    async upsertGitHubUser(record) {
      const values = githubUserValues(record);
      await db
        .insert(githubUsers)
        .values(values)
        .onConflictDoUpdate({
          target: githubUsers.githubUserId,
          set: {
            login: values.login,
            name: values.name,
            avatarUrl: values.avatarUrl,
            updatedAt: values.updatedAt,
          },
        });
    },
    async upsertGitHubInstallation(record) {
      const values = githubInstallationValues(record);
      await db
        .insert(githubInstallations)
        .values(values)
        .onConflictDoUpdate({
          target: githubInstallations.installationId,
          set: {
            accountLogin: values.accountLogin,
            accountType: values.accountType,
            permissions: values.permissions,
            repositorySelection: values.repositorySelection,
            suspendedAt: values.suspendedAt,
            updatedAt: values.updatedAt,
          },
        });
    },
    async upsertGitHubRepository(record) {
      const values = githubRepositoryValues(record);
      await db
        .insert(githubRepositories)
        .values(values)
        .onConflictDoUpdate({
          target: githubRepositories.repositoryId,
          set: {
            installationId: values.installationId,
            owner: values.owner,
            name: values.name,
            fullName: values.fullName,
            visibility: values.visibility,
            permissions: values.permissions,
            deletedAt: values.deletedAt,
            updatedAt: values.updatedAt,
          },
        });
    },
    async upsertGitHubRepositoryPermission(record) {
      await db
        .insert(githubRepositoryPermissions)
        .values({
          githubUserId: record.githubUserId,
          repositoryId: record.repositoryId,
          permission: record.permission,
          updatedAt: new Date(record.updatedAt),
        })
        .onConflictDoUpdate({
          target: [
            githubRepositoryPermissions.githubUserId,
            githubRepositoryPermissions.repositoryId,
          ],
          set: {
            permission: record.permission,
            updatedAt: new Date(record.updatedAt),
          },
        });
    },
    async appendAuthAuditEvent(record) {
      await db.insert(authAuditEvents).values(authAuditEventValues(record));
    },
    async listAuthAuditEvents() {
      const rows = await db
        .select()
        .from(authAuditEvents)
        .orderBy(asc(authAuditEvents.createdAt));
      return rows.map(authAuditEventRecordFromRow);
    },
  };
}

/**
 * Creates a durable review store from a node-postgres pool or connection string.
 *
 * @param config - PostgreSQL connection string or pool configuration.
 * @returns A closable review store backed by Drizzle and node-postgres.
 */
export function createPostgresReviewStore(
  config: string | PoolConfig
): ClosableReviewStore {
  const pool =
    typeof config === 'string'
      ? new pg.Pool({ connectionString: config })
      : new pg.Pool(config);
  pool.on('error', (error) => {
    console.error('[review-service] PostgreSQL pool idle client error', error);
  });
  const db = drizzleNodePostgres(pool, { schema });
  return {
    ...createDrizzleReviewStore(db),
    close() {
      return pool.end();
    },
  };
}

/**
 * Creates a durable auth store from a node-postgres pool or connection string.
 *
 * @param config - PostgreSQL connection string or pool configuration.
 * @returns A closable auth store backed by Drizzle and node-postgres.
 */
export function createPostgresReviewAuthStore(
  config: string | PoolConfig
): ReviewAuthStoreAdapter & { close(): Promise<void> } {
  const pool =
    typeof config === 'string'
      ? new pg.Pool({ connectionString: config })
      : new pg.Pool(config);
  pool.on('error', (error) => {
    console.error(
      '[review-service] PostgreSQL auth pool idle client error',
      error
    );
  });
  const db = drizzleNodePostgres(pool, { schema });
  return {
    ...createDrizzleReviewAuthStore(db),
    close() {
      return pool.end();
    },
  };
}

/**
 * Creates the configured service store from process environment variables.
 *
 * @param env - Environment object containing `DATABASE_URL` or `POSTGRES_URL`.
 * @param options - Runtime fallback policy.
 * @returns A Postgres store when configured, otherwise an in-memory store.
 * @throws Error - When neither `DATABASE_URL` nor `POSTGRES_URL` is set and in-memory fallback is disallowed.
 */
export function createReviewStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { allowInMemoryFallback?: boolean } = {}
): ReviewStoreAdapter {
  const databaseUrl = env.DATABASE_URL ?? env.POSTGRES_URL;
  if (!databaseUrl) {
    const allowInMemoryFallback =
      options.allowInMemoryFallback ??
      (env.REVIEW_SERVICE_STORAGE === 'memory' ||
        env.NODE_ENV !== 'production');
    if (!allowInMemoryFallback) {
      throw new Error(
        'DATABASE_URL or POSTGRES_URL is required for review-service durable storage in production'
      );
    }
    return createInMemoryReviewStore();
  }
  return createPostgresReviewStore(databaseUrl);
}

/**
 * Creates the configured auth store from process environment variables.
 *
 * @param env - Environment object containing `DATABASE_URL` or `POSTGRES_URL`.
 * @param options - Runtime fallback policy.
 * @returns A Postgres auth store when configured, otherwise an in-memory store.
 * @throws Error - When no database URL is configured and in-memory fallback is disallowed.
 */
export function createReviewAuthStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { allowInMemoryFallback?: boolean } = {}
): ReviewAuthStoreAdapter {
  const databaseUrl = env.DATABASE_URL ?? env.POSTGRES_URL;
  if (!databaseUrl) {
    const allowInMemoryFallback =
      options.allowInMemoryFallback ??
      (env.REVIEW_SERVICE_STORAGE === 'memory' ||
        env.NODE_ENV !== 'production');
    if (!allowInMemoryFallback) {
      throw new Error(
        'DATABASE_URL or POSTGRES_URL is required for review-service auth storage in production'
      );
    }
    return createInMemoryReviewAuthStore();
  }
  return createPostgresReviewAuthStore(databaseUrl);
}

/**
 * Lists artifact metadata rows for tests and operational diagnostics.
 *
 * @param db - Drizzle PostgreSQL database connected with the review storage schema.
 * @param reviewId - Review identifier whose artifacts should be listed.
 * @returns Artifact metadata without stored content bodies.
 */
export async function listArtifactMetadata(
  db: ReviewStorageDatabase,
  reviewId: string
): Promise<
  Array<
    Omit<typeof reviewArtifacts.$inferSelect, 'content' | 'createdAt'> & {
      createdAt: number;
    }
  >
> {
  const rows = await db
    .select()
    .from(reviewArtifacts)
    .where(eq(reviewArtifacts.reviewId, reviewId));
  return rows.map(({ content: _content, createdAt, ...row }) => ({
    ...row,
    createdAt: createdAt.getTime(),
  }));
}

/**
 * Lists status transitions for tests and operational diagnostics.
 *
 * @param db - Drizzle PostgreSQL database connected with the review storage schema.
 * @param reviewId - Review identifier whose transitions should be listed.
 * @returns Status transitions ordered by creation time.
 */
export async function listStatusTransitions(
  db: ReviewStorageDatabase,
  reviewId: string
): Promise<Array<typeof reviewStatusTransitions.$inferSelect>> {
  return db
    .select()
    .from(reviewStatusTransitions)
    .where(eq(reviewStatusTransitions.reviewId, reviewId))
    .orderBy(asc(reviewStatusTransitions.createdAt));
}

/**
 * Deletes review records whose identifiers are in the supplied list.
 *
 * @param db - Drizzle PostgreSQL database connected with the review storage schema.
 * @param reviewIds - Review identifiers to delete in one SQL statement.
 */
export async function deleteReviewsById(
  db: ReviewStorageDatabase,
  reviewIds: string[]
): Promise<void> {
  if (reviewIds.length === 0) {
    return;
  }
  await db.delete(reviewRuns).where(inArray(reviewRuns.reviewId, reviewIds));
}
