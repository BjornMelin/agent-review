import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { ReviewRunResult } from '@review-agent/review-core';
import type {
  LifecycleEvent,
  ReviewRequest,
  ReviewResult,
} from '@review-agent/review-types';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it } from 'vitest';
import {
  createDrizzleReviewStore,
  createInMemoryReviewStore,
  createReviewStoreFromEnv,
  deleteReviewsById,
  listArtifactMetadata,
  listStatusTransitions,
  type ReviewRecord,
} from './index.js';
import * as schema from './schema.js';
import { reviewEvents, reviewRuns } from './schema.js';

const BASE_TIME_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

type TestStoreContext = Awaited<ReturnType<typeof createTestStore>>;

async function createTestStore() {
  const client = new PGlite();
  await client.waitReady;
  await client.exec(await readInitialMigrationSql());
  const db = drizzle(client, { schema });
  return {
    client,
    db,
    store: createDrizzleReviewStore(db),
  };
}

async function readInitialMigrationSql(): Promise<string> {
  return readFile(
    fileURLToPath(
      new URL('../../drizzle/0000_initial_review_storage.sql', import.meta.url)
    ),
    'utf8'
  );
}

async function withTestStore<T>(
  callback: (context: TestStoreContext) => Promise<T>
): Promise<T> {
  const context = await createTestStore();
  try {
    return await callback(context);
  } finally {
    await context.client.close();
  }
}

function createRequest(): ReviewRequest {
  return {
    cwd: '/repo',
    target: {
      type: 'custom',
      instructions: 'review this branch',
    },
    provider: 'codexDelegate',
    executionMode: 'localTrusted',
    outputFormats: ['json', 'markdown'],
  };
}

function createReviewResult(request: ReviewRequest): ReviewRunResult {
  const result: ReviewResult = {
    findings: [],
    overallCorrectness: 'patch is correct',
    overallExplanation: 'storage contract passes',
    overallConfidenceScore: 1,
    metadata: {
      provider: request.provider,
      modelResolved: 'codex-test',
      executionMode: request.executionMode,
      promptPack: 'test-pack',
      gitContext: {
        mode: 'custom',
      },
    },
  };

  return {
    reviewId: 'review-1',
    request,
    result,
    artifacts: {
      json: JSON.stringify(result),
      markdown: '# Review\n\nNo findings.',
    },
    diff: {
      patch: 'diff --git a/file.ts b/file.ts',
      chunks: [
        {
          file: 'file.ts',
          absoluteFilePath: '/repo/file.ts',
          patch: '@@ -1 +1 @@\n+const value = 1;',
          changedLines: [1],
        },
      ],
      changedLineIndex: new Map([['file.ts', new Set([1])]]),
      gitContext: {
        mode: 'custom',
      },
    },
    prompt: 'prompt',
    rubric: 'rubric',
  };
}

function createEvent(
  reviewId: string,
  sequence: number,
  message: string
): LifecycleEvent {
  return {
    type: 'progress',
    message,
    meta: {
      eventId: `event-${sequence}`,
      timestampMs: BASE_TIME_MS + sequence,
      correlation: {
        reviewId,
      },
    },
  };
}

function createRecord(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  const request = overrides.request ?? createRequest();
  return {
    reviewId: 'review-1',
    status: 'queued',
    request,
    createdAt: BASE_TIME_MS,
    updatedAt: BASE_TIME_MS,
    events: [],
    ...overrides,
  };
}

describe('review storage', () => {
  it('hydrates run records across store instances', async () => {
    await withTestStore(async ({ db, store }) => {
      const request = createRequest();
      const expected = createRecord({
        status: 'completed',
        request,
        updatedAt: BASE_TIME_MS + 1_000,
        result: createReviewResult(request),
        events: [createEvent('review-1', 1, 'started')],
        retentionExpiresAt: BASE_TIME_MS + 86_400_000,
      });

      await store.set(expected, { reason: 'completed' });
      const restartedStore = createDrizzleReviewStore(db);
      const actual = await restartedStore.get('review-1');

      expect(actual).toMatchObject({
        reviewId: 'review-1',
        status: 'completed',
        retentionExpiresAt: BASE_TIME_MS + 86_400_000,
      });
      expect(actual?.result?.artifacts.markdown).toBe(
        '# Review\n\nNo findings.'
      );
      expect(actual?.result?.diff.changedLineIndex.get('file.ts')).toEqual(
        new Set([1])
      );
      expect(actual?.events.map((event) => event.meta.eventId)).toEqual([
        'event-1',
      ]);
    });
  });

  it('persists lifecycle events in sequence and trims retained replay events', async () => {
    await withTestStore(async ({ store }) => {
      const record = createRecord();

      await store.set(record, { reason: 'created' });
      await store.appendEvent(record, createEvent('review-1', 1, 'one'), {
        maxEvents: 2,
        reason: 'event one',
      });
      await store.appendEvent(record, createEvent('review-1', 2, 'two'), {
        maxEvents: 2,
        reason: 'event two',
      });
      await store.appendEvent(record, createEvent('review-1', 3, 'three'), {
        maxEvents: 2,
        reason: 'event three',
      });

      const actual = await store.get('review-1');

      expect(record.events.map((event) => event.meta.eventId)).toEqual([
        'event-2',
        'event-3',
      ]);
      expect(actual?.events.map((event) => event.meta.eventId)).toEqual([
        'event-2',
        'event-3',
      ]);
      expect(
        actual?.events.map((event) =>
          event.type === 'progress' ? event.message : undefined
        )
      ).toEqual(['two', 'three']);
    });
  });

  it('stores artifact metadata separately from hydrated artifact content', async () => {
    await withTestStore(async ({ db, store }) => {
      const request = createRequest();
      const result = createReviewResult(request);
      await store.set(
        createRecord({
          request,
          result,
          status: 'completed',
          updatedAt: BASE_TIME_MS + 1_000,
        }),
        { reason: 'completed' }
      );

      const metadata = await listArtifactMetadata(db, 'review-1');

      expect(metadata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            format: 'markdown',
            contentType: 'text/markdown; charset=utf-8',
            byteLength: Buffer.byteLength(result.artifacts.markdown ?? ''),
            sha256: createHash('sha256')
              .update(result.artifacts.markdown ?? '')
              .digest('hex'),
            storageKey: 'postgres://review_artifacts/review-1/markdown',
          }),
          expect.objectContaining({
            format: 'json',
            contentType: 'application/json; charset=utf-8',
            byteLength: Buffer.byteLength(result.artifacts.json ?? ''),
            sha256: createHash('sha256')
              .update(result.artifacts.json ?? '')
              .digest('hex'),
            storageKey: 'postgres://review_artifacts/review-1/json',
          }),
        ])
      );

      const hydrated = await store.get('review-1');
      expect(hydrated?.result?.artifacts).toMatchObject(result.artifacts);

      const [run] = await db
        .select({ result: reviewRuns.result })
        .from(reviewRuns)
        .where(eq(reviewRuns.reviewId, 'review-1'));
      expect((run?.result as { artifacts?: unknown }).artifacts).toEqual({});
    });
  });

  it('appends events against current storage state from stale records', async () => {
    await withTestStore(async ({ store }) => {
      await store.set(createRecord(), { reason: 'created' });
      const first = await store.get('review-1');
      const second = await store.get('review-1');
      if (!first || !second) {
        throw new Error('expected hydrated records');
      }

      await store.appendEvent(first, createEvent('review-1', 1, 'one'), {
        maxEvents: 10,
        reason: 'first append',
      });
      await store.appendEvent(second, createEvent('review-1', 2, 'two'), {
        maxEvents: 10,
        reason: 'second append',
      });

      const actual = await store.get('review-1');
      expect(actual?.events.map((event) => event.meta.eventId)).toEqual([
        'event-1',
        'event-2',
      ]);
    });
  });

  it('keeps in-memory stale appends aligned with durable event semantics', async () => {
    const store = createInMemoryReviewStore();
    await store.set(
      createRecord({ events: [createEvent('review-1', 1, 'one')] }),
      {
        reason: 'created',
      }
    );
    const first = await store.get('review-1');
    const second = await store.get('review-1');
    if (!first || !second) {
      throw new Error('expected hydrated records');
    }

    await store.appendEvent(first, createEvent('review-1', 2, 'two'), {
      maxEvents: 10,
      reason: 'first append',
    });
    await store.appendEvent(second, createEvent('review-1', 3, 'three'), {
      maxEvents: 10,
      reason: 'second append',
    });

    const actual = await store.get('review-1');
    expect(actual?.events.map((event) => event.meta.eventId)).toEqual([
      'event-1',
      'event-2',
      'event-3',
    ]);
  });

  it('deduplicates retried event appends without advancing stored sequence', async () => {
    await withTestStore(async ({ db, store }) => {
      await store.set(createRecord(), { reason: 'created' });
      const first = await store.get('review-1');
      const second = await store.get('review-1');
      if (!first || !second) {
        throw new Error('expected hydrated records');
      }

      const event = createEvent('review-1', 1, 'one');
      await Promise.all([
        store.appendEvent(first, event, {
          maxEvents: 10,
          reason: 'first append',
        }),
        store.appendEvent(second, event, {
          maxEvents: 10,
          reason: 'retry append',
        }),
      ]);

      const actual = await store.get('review-1');
      const [run] = await db
        .select({ eventSequence: reviewRuns.eventSequence })
        .from(reviewRuns)
        .where(eq(reviewRuns.reviewId, 'review-1'));

      expect(actual?.events.map((item) => item.meta.eventId)).toEqual([
        'event-1',
      ]);
      expect(run?.eventSequence).toBe(1);
    });
  });

  it('keeps durable appendEvent from overwriting newer run fields', async () => {
    await withTestStore(async ({ store }) => {
      const request = createRequest();
      await store.set(createRecord({ request }), { reason: 'created' });
      const stale = await store.get('review-1');
      if (!stale) {
        throw new Error('expected hydrated record');
      }

      await store.set(
        createRecord({
          request,
          status: 'completed',
          result: createReviewResult(request),
          updatedAt: BASE_TIME_MS + 1_000,
          retentionExpiresAt: BASE_TIME_MS + 86_400_000,
        }),
        { reason: 'completed' }
      );
      await store.appendEvent(stale, createEvent('review-1', 1, 'one'), {
        maxEvents: 10,
        reason: 'stale append',
      });

      const actual = await store.get('review-1');
      expect(actual).toMatchObject({
        status: 'completed',
        retentionExpiresAt: BASE_TIME_MS + 86_400_000,
      });
      expect(actual?.result?.artifacts.markdown).toBe(
        '# Review\n\nNo findings.'
      );
      expect(actual?.events.map((event) => event.meta.eventId)).toEqual([
        'event-1',
      ]);
    });
  });

  it('keeps in-memory appendEvent from overwriting newer run fields', async () => {
    const request = createRequest();
    const store = createInMemoryReviewStore();
    await store.set(createRecord({ request }), { reason: 'created' });
    const stale = await store.get('review-1');
    if (!stale) {
      throw new Error('expected hydrated record');
    }

    await store.set(
      createRecord({
        request,
        status: 'completed',
        result: createReviewResult(request),
        updatedAt: BASE_TIME_MS + 1_000,
        retentionExpiresAt: BASE_TIME_MS + 86_400_000,
      }),
      { reason: 'completed' }
    );
    await store.appendEvent(stale, createEvent('review-1', 1, 'one'), {
      maxEvents: 10,
      reason: 'stale append',
    });

    const actual = await store.get('review-1');
    expect(actual).toMatchObject({
      status: 'completed',
      retentionExpiresAt: BASE_TIME_MS + 86_400_000,
    });
    expect(actual?.result?.artifacts.markdown).toBe('# Review\n\nNo findings.');
    expect(actual?.events.map((event) => event.meta.eventId)).toEqual([
      'event-1',
    ]);
  });

  it('preserves stored events when stale records update run state', async () => {
    await withTestStore(async ({ store }) => {
      await store.set(createRecord(), { reason: 'created' });
      const stale = await store.get('review-1');
      const current = await store.get('review-1');
      if (!stale || !current) {
        throw new Error('expected hydrated records');
      }

      await store.appendEvent(current, createEvent('review-1', 1, 'one'), {
        maxEvents: 10,
        reason: 'append event',
      });
      await store.set(
        { ...stale, status: 'running', updatedAt: BASE_TIME_MS + 1_000 },
        { reason: 'stale status update' }
      );

      const actual = await store.get('review-1');
      expect(actual).toMatchObject({ status: 'running' });
      expect(actual?.events.map((event) => event.meta.eventId)).toEqual([
        'event-1',
      ]);
    });
  });

  it('allocates event sequence numbers for concurrent appenders', async () => {
    await withTestStore(async ({ store }) => {
      await store.set(createRecord(), { reason: 'created' });
      const first = await store.get('review-1');
      const second = await store.get('review-1');
      if (!first || !second) {
        throw new Error('expected hydrated records');
      }

      await Promise.all([
        store.appendEvent(first, createEvent('review-1', 1, 'one'), {
          maxEvents: 10,
          reason: 'first append',
        }),
        store.appendEvent(second, createEvent('review-1', 2, 'two'), {
          maxEvents: 10,
          reason: 'second append',
        }),
      ]);

      const actual = await store.get('review-1');
      expect(actual?.events.map((event) => event.meta.eventId).sort()).toEqual([
        'event-1',
        'event-2',
      ]);
    });
  });

  it('records status transitions when run status changes', async () => {
    await withTestStore(async ({ db, store }) => {
      const queued = createRecord();
      await store.set(queued, { reason: 'queued' });
      await store.set(
        { ...queued, status: 'running', updatedAt: BASE_TIME_MS + 1_000 },
        { reason: 'started' }
      );
      await store.set(
        { ...queued, status: 'completed', updatedAt: BASE_TIME_MS + 2_000 },
        { reason: 'completed' }
      );

      const transitions = await listStatusTransitions(db, 'review-1');

      expect(transitions.map((transition) => transition.fromStatus)).toEqual([
        null,
        'queued',
        'running',
      ]);
      expect(transitions.map((transition) => transition.toStatus)).toEqual([
        'queued',
        'running',
        'completed',
      ]);
      expect(transitions.map((transition) => transition.reason)).toEqual([
        'queued',
        'started',
        'completed',
      ]);
    });
  });

  it('deletes runs with cascaded events, artifacts, and transitions', async () => {
    await withTestStore(async ({ db, store }) => {
      const request = createRequest();
      await store.set(
        createRecord({
          request,
          status: 'completed',
          result: createReviewResult(request),
          events: [createEvent('review-1', 1, 'started')],
          retentionExpiresAt: BASE_TIME_MS - 1,
          updatedAt: BASE_TIME_MS + 1_000,
        }),
        { reason: 'retention expired' }
      );

      await deleteReviewsById(db, ['review-1']);

      expect(await store.get('review-1')).toBeUndefined();
      expect(await listArtifactMetadata(db, 'review-1')).toEqual([]);
      expect(await listStatusTransitions(db, 'review-1')).toEqual([]);
      expect(
        await db
          .select()
          .from(reviewEvents)
          .where(eq(reviewEvents.reviewId, 'review-1'))
      ).toEqual([]);
    });
  });

  it('cleans up expired terminal runs without hydrating artifact content', async () => {
    await withTestStore(async ({ store }) => {
      const request = createRequest();
      await store.set(
        createRecord({
          reviewId: 'expired-review',
          request,
          status: 'completed',
          result: createReviewResult(request),
          retentionExpiresAt: BASE_TIME_MS - 1,
          updatedAt: BASE_TIME_MS,
        }),
        { reason: 'completed' }
      );
      await store.set(
        createRecord({
          reviewId: 'active-review',
          status: 'completed',
          retentionExpiresAt: BASE_TIME_MS + 10_000,
          updatedAt: BASE_TIME_MS,
        }),
        { reason: 'completed' }
      );
      await store.set(
        createRecord({
          reviewId: 'legacy-review',
          status: 'completed',
          updatedAt: BASE_TIME_MS - 86_400_001,
        }),
        { reason: 'completed without retention marker' }
      );

      const deletedReviewIds = await store.cleanup({
        nowMs: BASE_TIME_MS,
      });

      expect(deletedReviewIds).toEqual(['expired-review']);
      expect(await store.get('expired-review')).toBeUndefined();
      expect(await store.get('active-review')).toMatchObject({
        reviewId: 'active-review',
      });
      expect(await store.get('legacy-review')).toMatchObject({
        reviewId: 'legacy-review',
      });
    });
  });

  it('requires a database URL for production storage unless memory is explicit', () => {
    expect(() => createReviewStoreFromEnv({ NODE_ENV: 'production' })).toThrow(
      /DATABASE_URL or POSTGRES_URL/
    );
    expect(
      createReviewStoreFromEnv({
        NODE_ENV: 'production',
        REVIEW_SERVICE_STORAGE: 'memory',
      })
    ).toBeDefined();
  });

  it('publishes the manual migration through the Drizzle journal', async () => {
    const { readMigrationFiles } = await import('drizzle-orm/migrator');

    const migrations = readMigrationFiles({
      migrationsFolder: fileURLToPath(
        new URL('../../drizzle', import.meta.url)
      ),
    });

    expect(migrations).toHaveLength(1);
    expect(migrations[0]?.sql.join('\n').trim()).toBe(
      (await readInitialMigrationSql()).trim()
    );
  });
});
