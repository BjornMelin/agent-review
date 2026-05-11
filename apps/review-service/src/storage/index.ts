import { createHash, randomUUID } from 'node:crypto';
import type { ReviewRunResult } from '@review-agent/review-core';
import {
  ARTIFACT_CONTENT_TYPES,
  type LifecycleEvent,
  type OutputFormat,
  type ReviewRequest,
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
  reviewArtifacts,
  reviewEvents,
  reviewRuns,
  reviewStatusTransitions,
} from './schema.js';

type ReviewStorageSchema = typeof schema;
type ReviewStorageDatabase =
  | NodePgDatabase<ReviewStorageSchema>
  | PgliteDatabase<ReviewStorageSchema>;
type ReviewRunRow = typeof reviewRuns.$inferSelect;
type ReviewEventRow = typeof reviewEvents.$inferSelect;
type ReviewArtifactRow = typeof reviewArtifacts.$inferSelect;
type CleanupCandidate = {
  reviewId: string;
  status: ReviewRunStatus;
  updatedAt: Date;
  retentionExpiresAt: Date | null;
};

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
  createdAt: number;
  updatedAt: number;
  result?: ReviewRunResult;
  error?: string;
  detachedRunId?: string;
  workflowRunId?: string;
  sandboxId?: string;
  retentionExpiresAt?: number;
  deletedAt?: number;
  events: LifecycleEvent[];
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
 * Defines durable review storage for runs, lifecycle events, and artifact metadata.
 */
export type ReviewStoreAdapter = {
  get(reviewId: string): Promise<ReviewRecord | undefined>;
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
  if (record.retentionExpiresAt !== undefined) {
    next.retentionExpiresAt = record.retentionExpiresAt;
  }
  if (record.deletedAt !== undefined) {
    next.deletedAt = record.deletedAt;
  }
  return next;
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

function runInsertFor(record: ReviewRecord): typeof reviewRuns.$inferInsert {
  return {
    reviewId: record.reviewId,
    runId: record.detachedRunId ?? record.reviewId,
    status: record.status,
    request: record.request,
    requestSummary: buildRequestSummary(record.request),
    result: record.result ? serializeReviewRunResult(record.result) : null,
    error: record.error ?? null,
    detachedRunId: record.detachedRunId ?? null,
    workflowRunId: record.workflowRunId ?? record.detachedRunId ?? null,
    sandboxId: record.sandboxId ?? null,
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

  return {
    async get(reviewId) {
      const record = records.get(reviewId);
      return record ? cloneRecord(record) : undefined;
    },
    async set(record) {
      const existing = records.get(record.reviewId);
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
    requestSummary: insert.requestSummary,
    result: insert.result,
    error: insert.error,
    detachedRunId: insert.detachedRunId,
    workflowRunId: insert.workflowRunId,
    sandboxId: insert.sandboxId,
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
              await tx
                .update(reviewRuns)
                .set(rowUpdateFor(record))
                .where(eq(reviewRuns.reviewId, record.reviewId));
              return row;
            })();
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
