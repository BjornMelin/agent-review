import { createHash, randomUUID } from 'node:crypto';
import type { ReviewRunResult } from '@review-agent/review-core';
import {
  ARTIFACT_CONTENT_TYPES,
  type LifecycleEvent,
  type OutputFormat,
  type ReviewArtifactMetadata,
  type ReviewAuthPrincipal,
  type ReviewAuthScope,
  type ReviewFindingTriageAuditRecord,
  type ReviewFindingTriageListResponse,
  type ReviewFindingTriageRecord,
  type ReviewFindingTriageStatus,
  type ReviewPublicationRecord,
  type ReviewRepositoryAuthorization,
  type ReviewRequest,
  type ReviewRunAuthorization,
  type ReviewRunLease,
  type ReviewRunListResponse,
  type ReviewRunStatus,
  type ReviewRunSummary,
  redactErrorMessage,
} from '@review-agent/review-types';
import type { SQL } from 'drizzle-orm';
import { and, asc, count, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
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
  reviewFindingTriage,
  reviewFindingTriageAudit,
  reviewPublications,
  reviewRuns,
  reviewStatusTransitions,
  serviceTokens,
} from './schema.js';

type ReviewStorageSchema = typeof schema;
type ReviewStorageDatabase =
  | NodePgDatabase<ReviewStorageSchema>
  | PgliteDatabase<ReviewStorageSchema>;
type ReviewRunRow = typeof reviewRuns.$inferSelect;
type ReviewRunListRow = Pick<
  ReviewRunRow,
  | 'reviewId'
  | 'runId'
  | 'status'
  | 'requestSummary'
  | 'authorization'
  | 'error'
  | 'detachedRunId'
  | 'workflowRunId'
  | 'sandboxId'
  | 'cancelRequestedAt'
  | 'completedAt'
  | 'createdAt'
  | 'updatedAt'
> & {
  requestModel: string | null;
  findingCount: number | string | null;
  modelResolved: string | null;
};
type ReviewEventRow = typeof reviewEvents.$inferSelect;
type ReviewArtifactRow = typeof reviewArtifacts.$inferSelect;
type ReviewPublicationRow = typeof reviewPublications.$inferSelect;
type ReviewFindingTriageRow = typeof reviewFindingTriage.$inferSelect;
type ReviewFindingTriageAuditRow = typeof reviewFindingTriageAudit.$inferSelect;
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
 * Carries the opaque run-list cursor after service-level decoding.
 */
export type ReviewRunListCursor = {
  updatedAt: number;
  reviewId: string;
};

/**
 * Filters run lists to one or more authorized repositories.
 */
export type ReviewStoreListRepositoryFilter = Pick<
  ReviewRepositoryAuthorization,
  'repositoryId' | 'installationId' | 'owner' | 'name'
>;

/**
 * Defines paginated run-list controls for operational views.
 */
export type ReviewStoreListOptions = {
  limit: number;
  cursor?: ReviewRunListCursor;
  status?: ReviewRunStatus;
  repositories?: ReviewStoreListRepositoryFilter[];
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
  list(options: ReviewStoreListOptions): Promise<ReviewRunListResponse>;
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
 * Defines durable publication-state storage for outbound GitHub side effects.
 */
export type ReviewPublicationStoreAdapter = {
  list(reviewId: string): Promise<ReviewPublicationRecord[]>;
  upsert(record: ReviewPublicationRecord): Promise<void>;
};

/**
 * Defines one finding-triage write operation with audit context.
 */
export type ReviewFindingTriageUpsert = {
  reviewId: string;
  fingerprint: string;
  status: ReviewFindingTriageStatus;
  note?: string;
  actor?: string;
  nowMs: number;
};

/**
 * Defines durable finding-triage storage for Review Room collaboration state.
 */
export type ReviewFindingTriageStoreAdapter = {
  list(reviewId: string): Promise<ReviewFindingTriageListResponse>;
  upsert(input: ReviewFindingTriageUpsert): Promise<{
    record: ReviewFindingTriageRecord;
    audit: ReviewFindingTriageAuditRecord;
  }>;
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

function repositorySummaryFor(
  authorization: ReviewRunAuthorization | undefined | null
): ReviewRunSummary['repository'] {
  if (!authorization) {
    return undefined;
  }
  const repository = authorization.repository;
  return {
    provider: repository.provider,
    owner: repository.owner,
    name: repository.name,
    fullName: repository.fullName,
    repositoryId: repository.repositoryId,
    installationId: repository.installationId,
    visibility: repository.visibility,
    ...(repository.pullRequestNumber === undefined
      ? {}
      : { pullRequestNumber: repository.pullRequestNumber }),
    ...(repository.ref === undefined ? {} : { ref: repository.ref }),
    ...(repository.commitSha === undefined
      ? {}
      : { commitSha: repository.commitSha }),
  };
}

/**
 * Builds artifact metadata from a hydrated review record without exposing artifact bodies.
 *
 * @param record - Review record whose generated artifacts should be summarized.
 * @returns Artifact metadata suitable for service responses and Review Room links.
 */
export function artifactMetadataForRecord(
  record: ReviewRecord
): ReviewArtifactMetadata[] {
  if (!record.result) {
    return [];
  }
  return Object.entries(record.result.artifacts).flatMap(
    ([format, content]) => {
      if (!content) {
        return [];
      }
      const outputFormat = format as OutputFormat;
      return [
        {
          reviewId: record.reviewId,
          format: outputFormat,
          contentType: ARTIFACT_CONTENT_TYPES[outputFormat],
          byteLength: Buffer.byteLength(content),
          createdAt: record.updatedAt,
        },
      ];
    }
  );
}

/**
 * Builds the compact operational summary used by run lists and status details.
 *
 * @param record - Review record to summarize.
 * @param options - Optional precomputed counts and artifact formats.
 * @returns Redaction-safe summary with no host-local path fields.
 */
export function buildReviewRunSummary(
  record: ReviewRecord,
  options: {
    artifactFormats?: OutputFormat[];
    publicationCount?: number;
  } = {}
): ReviewRunSummary {
  const artifactFormats =
    options.artifactFormats ??
    artifactMetadataForRecord(record).map((artifact) => artifact.format);
  return {
    reviewId: record.reviewId,
    status: record.status,
    request: {
      provider: record.request.provider,
      executionMode: record.request.executionMode,
      targetType: record.request.target.type,
      outputFormats: record.request.outputFormats,
      ...(record.request.model === undefined
        ? {}
        : { model: record.request.model }),
    },
    ...(record.authorization
      ? { repository: repositorySummaryFor(record.authorization) }
      : {}),
    ...(record.error ? { error: redactErrorMessage(record.error) } : {}),
    findingCount: record.result?.result.findings.length ?? 0,
    artifactFormats,
    publicationCount: options.publicationCount ?? 0,
    ...(record.result?.result.metadata.modelResolved
      ? { modelResolved: record.result.result.metadata.modelResolved }
      : {}),
    ...(record.detachedRunId ? { detachedRunId: record.detachedRunId } : {}),
    ...(record.workflowRunId ? { workflowRunId: record.workflowRunId } : {}),
    ...(record.sandboxId ? { sandboxId: record.sandboxId } : {}),
    ...(record.cancelRequestedAt === undefined
      ? {}
      : { cancelRequestedAt: record.cancelRequestedAt }),
    ...(isTerminalStatus(record.status)
      ? { completedAt: record.updatedAt }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function buildReviewRunSummaryForListRow(
  run: ReviewRunListRow,
  options: {
    artifactFormats?: OutputFormat[];
    publicationCount?: number;
  } = {}
): ReviewRunSummary {
  const completedAt = msFromDate(run.completedAt);
  const findingCount = Number(run.findingCount ?? 0);
  return {
    reviewId: run.reviewId,
    status: run.status,
    request: {
      provider: run.requestSummary.provider,
      executionMode: run.requestSummary.executionMode,
      targetType: run.requestSummary.targetType,
      outputFormats: run.requestSummary.outputFormats,
      ...(run.requestModel ? { model: run.requestModel } : {}),
    },
    ...(run.authorization
      ? { repository: repositorySummaryFor(run.authorization) }
      : {}),
    ...(run.error ? { error: redactErrorMessage(run.error) } : {}),
    findingCount: Number.isFinite(findingCount) ? findingCount : 0,
    artifactFormats: options.artifactFormats ?? [],
    publicationCount: options.publicationCount ?? 0,
    ...(run.modelResolved ? { modelResolved: run.modelResolved } : {}),
    ...(run.detachedRunId ? { detachedRunId: run.detachedRunId } : {}),
    ...(run.workflowRunId ? { workflowRunId: run.workflowRunId } : {}),
    ...(run.sandboxId ? { sandboxId: run.sandboxId } : {}),
    ...(msFromDate(run.cancelRequestedAt) === undefined
      ? {}
      : { cancelRequestedAt: msFromDate(run.cancelRequestedAt) }),
    ...(completedAt === undefined ? {} : { completedAt }),
    createdAt: run.createdAt.getTime(),
    updatedAt: run.updatedAt.getTime(),
  };
}

function encodeReviewRunListCursor(summary: ReviewRunSummary): string {
  return Buffer.from(
    JSON.stringify({
      updatedAt: summary.updatedAt,
      reviewId: summary.reviewId,
    }),
    'utf8'
  ).toString('base64url');
}

/**
 * Decodes an opaque run-list cursor emitted by the service store.
 *
 * @param cursor - Base64url cursor from a previous list response.
 * @returns Decoded cursor with updated-at and review-id tie breaker.
 * @throws Error when the cursor is malformed.
 */
export function decodeReviewRunListCursor(cursor: string): ReviewRunListCursor {
  const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.updatedAt !== 'number' ||
    !Number.isSafeInteger(parsed.updatedAt) ||
    parsed.updatedAt < 0 ||
    typeof parsed.reviewId !== 'string' ||
    parsed.reviewId.length === 0
  ) {
    throw new Error('invalid review run list cursor');
  }
  return { updatedAt: parsed.updatedAt, reviewId: parsed.reviewId };
}

function compareRunSummariesForList(
  left: ReviewRunSummary,
  right: ReviewRunSummary
): number {
  const updatedAtCompare = right.updatedAt - left.updatedAt;
  return updatedAtCompare === 0
    ? right.reviewId.localeCompare(left.reviewId)
    : updatedAtCompare;
}

function isSummaryAfterCursor(
  summary: ReviewRunSummary,
  cursor: ReviewRunListCursor | undefined
): boolean {
  if (!cursor) {
    return true;
  }
  return (
    summary.updatedAt < cursor.updatedAt ||
    (summary.updatedAt === cursor.updatedAt &&
      summary.reviewId.localeCompare(cursor.reviewId) < 0)
  );
}

function runListResponseFromSummaries(
  summaries: ReviewRunSummary[],
  limit: number,
  hasNext = summaries.length > limit
): ReviewRunListResponse {
  const runs = summaries.slice(0, limit);
  const last = runs.at(-1);
  return {
    runs,
    ...(hasNext && last ? { nextCursor: encodeReviewRunListCursor(last) } : {}),
  };
}

function repositoryMatchesFilter(
  authorization: ReviewRunAuthorization | undefined,
  filters: ReviewStoreListRepositoryFilter[] | undefined
): boolean {
  if (!filters || filters.length === 0) {
    return true;
  }
  if (!authorization) {
    return false;
  }
  return filters.some((filter) => {
    const repository = authorization.repository;
    if (repository.repositoryId === filter.repositoryId) {
      return true;
    }
    return (
      repository.installationId === filter.installationId &&
      repository.owner.toLowerCase() === filter.owner.toLowerCase() &&
      repository.name.toLowerCase() === filter.name.toLowerCase()
    );
  });
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
    async list(options) {
      const summaries = [...records.values()]
        .filter((record) => {
          if (options.status && record.status !== options.status) {
            return false;
          }
          return repositoryMatchesFilter(
            record.authorization,
            options.repositories
          );
        })
        .map((record) => buildReviewRunSummary(record))
        .filter((summary) => isSummaryAfterCursor(summary, options.cursor))
        .sort(compareRunSummariesForList);
      return runListResponseFromSummaries(summaries, options.limit);
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

function clonePublicationRecord(
  record: ReviewPublicationRecord
): ReviewPublicationRecord {
  return structuredClone(record);
}

function cloneFindingTriageRecord(
  record: ReviewFindingTriageRecord
): ReviewFindingTriageRecord {
  return structuredClone(record);
}

function cloneFindingTriageAuditRecord(
  record: ReviewFindingTriageAuditRecord
): ReviewFindingTriageAuditRecord {
  return structuredClone(record);
}

function publicationIdentityKey(record: ReviewPublicationRecord): string {
  return `${record.reviewId}:${record.channel}:${record.targetKey}`;
}

/**
 * Creates an in-memory publication store for local tests and no-database development.
 *
 * @returns A copy-on-read publication store with deterministic upsert semantics.
 */
export function createInMemoryReviewPublicationStore(): ReviewPublicationStoreAdapter {
  const records = new Map<string, ReviewPublicationRecord>();

  return {
    async list(reviewId) {
      return [...records.values()]
        .filter((record) => record.reviewId === reviewId)
        .sort((left, right) => {
          const channelCompare = left.channel.localeCompare(right.channel);
          return channelCompare === 0
            ? left.targetKey.localeCompare(right.targetKey)
            : channelCompare;
        })
        .map(clonePublicationRecord);
    },
    async upsert(record) {
      const key = publicationIdentityKey(record);
      const previous = records.get(key);
      records.set(
        key,
        clonePublicationRecord({
          ...record,
          publicationId: previous?.publicationId ?? record.publicationId,
          createdAt: previous?.createdAt ?? record.createdAt,
        })
      );
    },
  };
}

/**
 * Creates an in-memory finding-triage store for local tests and no-database development.
 *
 * @returns A copy-on-read finding-triage store with append-only audit history.
 */
export function createInMemoryReviewFindingTriageStore(): ReviewFindingTriageStoreAdapter {
  const records = new Map<string, ReviewFindingTriageRecord>();
  const audit: ReviewFindingTriageAuditRecord[] = [];

  return {
    async list(reviewId) {
      return {
        reviewId,
        items: [...records.values()]
          .filter((record) => record.reviewId === reviewId)
          .sort((left, right) =>
            left.fingerprint.localeCompare(right.fingerprint)
          )
          .map(cloneFindingTriageRecord),
        audit: audit
          .filter((record) => record.reviewId === reviewId)
          .sort((left, right) => left.createdAt - right.createdAt)
          .map(cloneFindingTriageAuditRecord),
      };
    },
    async upsert(input) {
      const key = `${input.reviewId}:${input.fingerprint}`;
      const previous = records.get(key);
      const note = input.note?.trim() ? input.note.trim() : undefined;
      const record: ReviewFindingTriageRecord = {
        reviewId: input.reviewId,
        fingerprint: input.fingerprint,
        status: input.status,
        ...(note ? { note } : {}),
        ...(input.actor ? { actor: input.actor } : {}),
        createdAt: previous?.createdAt ?? input.nowMs,
        updatedAt: input.nowMs,
      };
      const auditRecord: ReviewFindingTriageAuditRecord = {
        auditId: randomUUID(),
        reviewId: input.reviewId,
        fingerprint: input.fingerprint,
        ...(previous ? { fromStatus: previous.status } : {}),
        toStatus: input.status,
        ...(note ? { note } : {}),
        ...(input.actor ? { actor: input.actor } : {}),
        createdAt: input.nowMs,
      };
      records.set(key, cloneFindingTriageRecord(record));
      audit.push(cloneFindingTriageAuditRecord(auditRecord));
      return {
        record: cloneFindingTriageRecord(record),
        audit: cloneFindingTriageAuditRecord(auditRecord),
      };
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
      const touchedAt = Math.max(
        record.lastUsedAt ?? Number.NEGATIVE_INFINITY,
        lastUsedAt
      );
      tokens.set(tokenId, {
        ...record,
        lastUsedAt: touchedAt,
        updatedAt: Math.max(record.updatedAt, touchedAt),
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

function reviewListRepositoryPredicate(
  repositories: ReviewStoreListRepositoryFilter[] | undefined
): SQL | undefined {
  if (!repositories || repositories.length === 0) {
    return undefined;
  }
  const predicates = repositories
    .map((repository) =>
      or(
        eq(reviewRuns.githubRepositoryId, String(repository.repositoryId)),
        and(
          eq(
            reviewRuns.githubInstallationId,
            String(repository.installationId)
          ),
          eq(reviewRuns.githubOwner, repository.owner),
          eq(reviewRuns.githubRepo, repository.name)
        )
      )
    )
    .filter((predicate): predicate is SQL => Boolean(predicate));
  const first = predicates[0];
  if (!first) {
    return undefined;
  }
  return predicates.length === 1 && first ? first : or(...predicates);
}

function reviewListCursorPredicate(
  cursor: ReviewRunListCursor | undefined
): SQL | undefined {
  if (!cursor) {
    return undefined;
  }
  const cursorDate = new Date(cursor.updatedAt);
  return or(
    lt(reviewRuns.updatedAt, cursorDate),
    and(
      eq(reviewRuns.updatedAt, cursorDate),
      lt(reviewRuns.reviewId, cursor.reviewId)
    )
  );
}

function reviewListWherePredicate(
  options: ReviewStoreListOptions
): SQL | undefined {
  const predicates = [
    options.status ? eq(reviewRuns.status, options.status) : undefined,
    reviewListRepositoryPredicate(options.repositories),
    reviewListCursorPredicate(options.cursor),
  ].filter((predicate): predicate is SQL => Boolean(predicate));
  const first = predicates[0];
  return predicates.length === 0
    ? undefined
    : predicates.length === 1 && first
      ? first
      : and(...predicates);
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
    async list(options) {
      const rows = await db
        .select({
          reviewId: reviewRuns.reviewId,
          runId: reviewRuns.runId,
          status: reviewRuns.status,
          requestSummary: reviewRuns.requestSummary,
          authorization: reviewRuns.authorization,
          error: reviewRuns.error,
          detachedRunId: reviewRuns.detachedRunId,
          workflowRunId: reviewRuns.workflowRunId,
          sandboxId: reviewRuns.sandboxId,
          cancelRequestedAt: reviewRuns.cancelRequestedAt,
          completedAt: reviewRuns.completedAt,
          createdAt: reviewRuns.createdAt,
          updatedAt: reviewRuns.updatedAt,
          requestModel: sql<string | null>`${reviewRuns.request}->>'model'`.as(
            'request_model'
          ),
          findingCount: sql<
            number | string | null
          >`coalesce(jsonb_array_length(${reviewRuns.result}->'result'->'findings'), 0)`.as(
            'finding_count'
          ),
          modelResolved: sql<
            string | null
          >`${reviewRuns.result}->'result'->'metadata'->>'modelResolved'`.as(
            'model_resolved'
          ),
        })
        .from(reviewRuns)
        .where(reviewListWherePredicate(options) ?? sql`true`)
        .orderBy(desc(reviewRuns.updatedAt), desc(reviewRuns.reviewId))
        .limit(options.limit + 1);
      const selectedRows = rows.slice(0, options.limit);
      const reviewIds = selectedRows.map((row) => row.reviewId);
      const artifactFormatsByReviewId = new Map<string, OutputFormat[]>();
      const publicationCountsByReviewId = new Map<string, number>();

      if (reviewIds.length > 0) {
        const [artifacts, publications] = await Promise.all([
          db
            .select({
              reviewId: reviewArtifacts.reviewId,
              format: reviewArtifacts.format,
            })
            .from(reviewArtifacts)
            .where(inArray(reviewArtifacts.reviewId, reviewIds)),
          db
            .select({ reviewId: reviewPublications.reviewId })
            .from(reviewPublications)
            .where(inArray(reviewPublications.reviewId, reviewIds)),
        ]);
        for (const artifact of artifacts) {
          const formats =
            artifactFormatsByReviewId.get(artifact.reviewId) ?? [];
          formats.push(artifact.format);
          artifactFormatsByReviewId.set(artifact.reviewId, formats);
        }
        for (const publication of publications) {
          publicationCountsByReviewId.set(
            publication.reviewId,
            (publicationCountsByReviewId.get(publication.reviewId) ?? 0) + 1
          );
        }
      }

      return runListResponseFromSummaries(
        selectedRows.map((row) =>
          buildReviewRunSummaryForListRow(row, {
            artifactFormats: artifactFormatsByReviewId.get(row.reviewId) ?? [],
            publicationCount:
              publicationCountsByReviewId.get(row.reviewId) ?? 0,
          })
        ),
        options.limit,
        rows.length > options.limit
      );
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

function publicationRecordFromRow(
  row: ReviewPublicationRow
): ReviewPublicationRecord {
  return {
    publicationId: row.publicationId,
    reviewId: row.reviewId,
    channel: row.channel,
    targetKey: row.targetKey,
    status: row.status,
    ...(row.externalId ? { externalId: row.externalId } : {}),
    ...(row.externalUrl ? { externalUrl: row.externalUrl } : {}),
    ...(row.marker ? { marker: row.marker } : {}),
    ...(row.message ? { message: row.message } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.metadata ? { metadata: row.metadata } : {}),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function publicationValues(
  record: ReviewPublicationRecord
): typeof reviewPublications.$inferInsert {
  return {
    publicationId: record.publicationId,
    reviewId: record.reviewId,
    channel: record.channel,
    targetKey: record.targetKey,
    status: record.status,
    externalId: record.externalId ?? null,
    externalUrl: record.externalUrl ?? null,
    marker: record.marker ?? null,
    message: record.message ?? null,
    error: record.error ?? null,
    metadata: record.metadata ?? null,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

function findingTriageRecordFromRow(
  row: ReviewFindingTriageRow
): ReviewFindingTriageRecord {
  return {
    reviewId: row.reviewId,
    fingerprint: row.fingerprint,
    status: row.status,
    ...(row.note ? { note: row.note } : {}),
    ...(row.actor ? { actor: row.actor } : {}),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function findingTriageAuditRecordFromRow(
  row: ReviewFindingTriageAuditRow
): ReviewFindingTriageAuditRecord {
  return {
    auditId: row.auditId,
    reviewId: row.reviewId,
    fingerprint: row.fingerprint,
    ...(row.fromStatus ? { fromStatus: row.fromStatus } : {}),
    toStatus: row.toStatus,
    ...(row.note ? { note: row.note } : {}),
    ...(row.actor ? { actor: row.actor } : {}),
    createdAt: row.createdAt.getTime(),
  };
}

/**
 * Creates a Drizzle-backed publication store for PostgreSQL-compatible databases.
 *
 * @param db - Drizzle PostgreSQL database connected with the review storage schema.
 * @returns A durable publication store for GitHub publication state.
 */
export function createDrizzleReviewPublicationStore(
  db: ReviewStorageDatabase
): ReviewPublicationStoreAdapter {
  return {
    async list(reviewId) {
      const rows = await db
        .select()
        .from(reviewPublications)
        .where(eq(reviewPublications.reviewId, reviewId))
        .orderBy(
          asc(reviewPublications.channel),
          asc(reviewPublications.targetKey)
        );
      return rows.map(publicationRecordFromRow);
    },
    async upsert(record) {
      const values = publicationValues(record);
      await db
        .insert(reviewPublications)
        .values(values)
        .onConflictDoUpdate({
          target: [
            reviewPublications.reviewId,
            reviewPublications.channel,
            reviewPublications.targetKey,
          ],
          set: {
            status: values.status,
            externalId: values.externalId,
            externalUrl: values.externalUrl,
            marker: values.marker,
            message: values.message,
            error: values.error,
            metadata: values.metadata,
            updatedAt: values.updatedAt,
          },
        });
    },
  };
}

/**
 * Creates a Drizzle-backed finding-triage store for PostgreSQL-compatible databases.
 *
 * @param db - Drizzle PostgreSQL database connected with the review storage schema.
 * @returns A durable finding-triage store with append-only audit records.
 */
export function createDrizzleReviewFindingTriageStore(
  db: ReviewStorageDatabase
): ReviewFindingTriageStoreAdapter {
  return {
    async list(reviewId) {
      const [items, audit] = await Promise.all([
        db
          .select()
          .from(reviewFindingTriage)
          .where(eq(reviewFindingTriage.reviewId, reviewId))
          .orderBy(asc(reviewFindingTriage.fingerprint)),
        db
          .select()
          .from(reviewFindingTriageAudit)
          .where(eq(reviewFindingTriageAudit.reviewId, reviewId))
          .orderBy(asc(reviewFindingTriageAudit.createdAt)),
      ]);
      return {
        reviewId,
        items: items.map(findingTriageRecordFromRow),
        audit: audit.map(findingTriageAuditRecordFromRow),
      };
    },
    async upsert(input) {
      return db.transaction(async (tx) => {
        const updatedAt = new Date(input.nowMs);
        const note = input.note?.trim() ? input.note.trim() : null;
        const [inserted] = await tx
          .insert(reviewFindingTriage)
          .values({
            reviewId: input.reviewId,
            fingerprint: input.fingerprint,
            status: input.status,
            note,
            actor: input.actor ?? null,
            createdAt: updatedAt,
            updatedAt,
          })
          .onConflictDoNothing()
          .returning();
        let previous: ReviewFindingTriageRow | undefined;
        let persisted = inserted;
        if (!persisted) {
          await tx.execute(sql`
            SELECT ${reviewFindingTriage.reviewId}
            FROM ${reviewFindingTriage}
            WHERE ${reviewFindingTriage.reviewId} = ${input.reviewId}
              AND ${reviewFindingTriage.fingerprint} = ${input.fingerprint}
            FOR UPDATE
          `);
          [previous] = await tx
            .select()
            .from(reviewFindingTriage)
            .where(
              and(
                eq(reviewFindingTriage.reviewId, input.reviewId),
                eq(reviewFindingTriage.fingerprint, input.fingerprint)
              )
            );
          const [updated] = await tx
            .update(reviewFindingTriage)
            .set({
              status: input.status,
              note,
              actor: input.actor ?? null,
              updatedAt,
            })
            .where(
              and(
                eq(reviewFindingTriage.reviewId, input.reviewId),
                eq(reviewFindingTriage.fingerprint, input.fingerprint)
              )
            )
            .returning();
          persisted = updated;
        }
        if (!persisted) {
          throw new Error('failed to persist finding triage record');
        }
        const auditRecord: ReviewFindingTriageAuditRecord = {
          auditId: randomUUID(),
          reviewId: input.reviewId,
          fingerprint: input.fingerprint,
          ...(previous ? { fromStatus: previous.status } : {}),
          toStatus: input.status,
          ...(note ? { note } : {}),
          ...(input.actor ? { actor: input.actor } : {}),
          createdAt: input.nowMs,
        };
        await tx.insert(reviewFindingTriageAudit).values({
          auditId: auditRecord.auditId,
          reviewId: auditRecord.reviewId,
          fingerprint: auditRecord.fingerprint,
          fromStatus: auditRecord.fromStatus ?? null,
          toStatus: auditRecord.toStatus,
          note: auditRecord.note ?? null,
          actor: auditRecord.actor ?? null,
          createdAt: new Date(auditRecord.createdAt),
        });
        return {
          record: findingTriageRecordFromRow(persisted),
          audit: auditRecord,
        };
      });
    },
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
      const touchedAt = new Date(lastUsedAt);
      await db
        .update(serviceTokens)
        .set({
          lastUsedAt: sql`GREATEST(COALESCE(${serviceTokens.lastUsedAt}, ${touchedAt}), ${touchedAt})`,
          updatedAt: sql`GREATEST(${serviceTokens.updatedAt}, ${touchedAt})`,
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
 * Creates a durable publication store from a node-postgres pool or connection string.
 *
 * @param config - PostgreSQL connection string or pool configuration.
 * @returns A closable publication store backed by Drizzle and node-postgres.
 */
export function createPostgresReviewPublicationStore(
  config: string | PoolConfig
): ReviewPublicationStoreAdapter & { close(): Promise<void> } {
  const pool =
    typeof config === 'string'
      ? new pg.Pool({ connectionString: config })
      : new pg.Pool(config);
  pool.on('error', (error) => {
    console.error(
      '[review-service] PostgreSQL publication pool idle client error',
      error
    );
  });
  const db = drizzleNodePostgres(pool, { schema });
  return {
    ...createDrizzleReviewPublicationStore(db),
    close() {
      return pool.end();
    },
  };
}

/**
 * Creates a durable finding-triage store from a node-postgres pool or connection string.
 *
 * @param config - PostgreSQL connection string or pool configuration.
 * @returns A closable finding-triage store backed by Drizzle and node-postgres.
 */
export function createPostgresReviewFindingTriageStore(
  config: string | PoolConfig
): ReviewFindingTriageStoreAdapter & { close(): Promise<void> } {
  const pool =
    typeof config === 'string'
      ? new pg.Pool({ connectionString: config })
      : new pg.Pool(config);
  pool.on('error', (error) => {
    console.error(
      '[review-service] PostgreSQL finding triage pool idle client error',
      error
    );
  });
  const db = drizzleNodePostgres(pool, { schema });
  return {
    ...createDrizzleReviewFindingTriageStore(db),
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
      options.allowInMemoryFallback ?? env.NODE_ENV !== 'production';
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
 * Creates the configured publication store from process environment variables.
 *
 * @param env - Environment object containing `DATABASE_URL` or `POSTGRES_URL`.
 * @param options - Runtime fallback policy.
 * @returns A Postgres publication store when configured, otherwise an in-memory store.
 * @throws Error - When no database URL is configured and in-memory fallback is disallowed.
 */
export function createReviewPublicationStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { allowInMemoryFallback?: boolean } = {}
): ReviewPublicationStoreAdapter {
  const databaseUrl = env.DATABASE_URL ?? env.POSTGRES_URL;
  if (!databaseUrl) {
    const allowInMemoryFallback =
      options.allowInMemoryFallback ?? env.NODE_ENV !== 'production';
    if (!allowInMemoryFallback) {
      throw new Error(
        'DATABASE_URL or POSTGRES_URL is required for review-service publication storage in production'
      );
    }
    return createInMemoryReviewPublicationStore();
  }
  return createPostgresReviewPublicationStore(databaseUrl);
}

/**
 * Creates the configured finding-triage store from process environment variables.
 *
 * @param env - Environment object containing `DATABASE_URL` or `POSTGRES_URL`.
 * @param options - Runtime fallback policy.
 * @returns A Postgres finding-triage store when configured, otherwise an in-memory store.
 * @throws Error - When no database URL is configured and in-memory fallback is disallowed.
 */
export function createReviewFindingTriageStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { allowInMemoryFallback?: boolean } = {}
): ReviewFindingTriageStoreAdapter {
  const databaseUrl = env.DATABASE_URL ?? env.POSTGRES_URL;
  if (!databaseUrl) {
    const allowInMemoryFallback =
      options.allowInMemoryFallback ?? env.NODE_ENV !== 'production';
    if (!allowInMemoryFallback) {
      throw new Error(
        'DATABASE_URL or POSTGRES_URL is required for review-service finding triage storage in production'
      );
    }
    return createInMemoryReviewFindingTriageStore();
  }
  return createPostgresReviewFindingTriageStore(databaseUrl);
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
