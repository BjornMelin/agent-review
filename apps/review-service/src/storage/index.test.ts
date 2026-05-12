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
  type AuthAuditEventRecord,
  createDrizzleReviewAuthStore,
  createDrizzleReviewStore,
  createInMemoryReviewAuthStore,
  createInMemoryReviewStore,
  createReviewAuthStoreFromEnv,
  createReviewStoreFromEnv,
  deleteReviewsById,
  listArtifactMetadata,
  listStatusTransitions,
  type ReviewRecord,
  type ServiceTokenRecord,
} from './index.js';
import * as schema from './schema.js';
import { reviewEvents, reviewRuns } from './schema.js';

const BASE_TIME_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

type TestStoreContext = Awaited<ReturnType<typeof createTestStore>>;

async function createTestStore() {
  const client = new PGlite();
  await client.waitReady;
  await client.exec(await readStorageMigrationSql());
  const db = drizzle(client, { schema });
  return {
    client,
    db,
    store: createDrizzleReviewStore(db),
  };
}

async function readStorageMigrationSql(): Promise<string> {
  return [
    await readInitialMigrationSql(),
    await readRuntimeControlMigrationSql(),
    await readGitHubAuthzMigrationSql(),
  ].join('\n');
}

async function readInitialMigrationSql(): Promise<string> {
  return readFile(
    fileURLToPath(
      new URL('../../drizzle/0000_initial_review_storage.sql', import.meta.url)
    ),
    'utf8'
  );
}

async function readRuntimeControlMigrationSql(): Promise<string> {
  return readFile(
    fileURLToPath(
      new URL('../../drizzle/0001_review_runtime_control.sql', import.meta.url)
    ),
    'utf8'
  );
}

async function readGitHubAuthzMigrationSql(): Promise<string> {
  return readFile(
    fileURLToPath(
      new URL('../../drizzle/0002_github_authz.sql', import.meta.url)
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

function runtimeScopeKeyForRequest(request: ReviewRequest): string {
  return `${request.executionMode}|${request.provider}|${request.cwd}|${request.target.type}`;
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

function createAuthorization(): NonNullable<ReviewRecord['authorization']> {
  return {
    principal: {
      type: 'serviceToken',
      tokenId: 'token-1',
      tokenPrefix: 'rat_token-1',
      name: 'CI',
    },
    repository: {
      provider: 'github',
      repositoryId: 42,
      installationId: 7,
      owner: 'octo-org',
      name: 'agent-review',
      fullName: 'octo-org/agent-review',
      visibility: 'private',
      permissions: { metadata: 'read', contents: 'read' },
      pullRequestNumber: 24,
      commitSha: 'abcdef1',
    },
    scopes: ['review:start', 'review:read', 'review:cancel'],
    actor: 'service-token:token-1',
    requestHash: 'sha256:request',
    authorizedAt: BASE_TIME_MS,
  };
}

function createServiceTokenRecord(): ServiceTokenRecord {
  return {
    tokenId: 'token-1',
    tokenPrefix: 'rat_token-1',
    tokenHash: 'hash',
    name: 'CI',
    scopes: ['review:start', 'review:read'],
    repository: createAuthorization().repository,
    createdAt: BASE_TIME_MS,
    updatedAt: BASE_TIME_MS,
  };
}

function createAuditEvent(): AuthAuditEventRecord {
  return {
    auditEventId: 'audit-1',
    eventType: 'authz',
    operation: 'review:start',
    result: 'allowed',
    reason: 'repository_scope_allowed',
    status: 200,
    principal: createAuthorization().principal,
    tokenId: 'token-1',
    tokenPrefix: 'rat_token-1',
    repository: createAuthorization().repository,
    reviewId: 'review-1',
    requestId: 'sha256:request',
    createdAt: BASE_TIME_MS,
  };
}

type LeasedReviewRecord = ReviewRecord & {
  lease: NonNullable<ReviewRecord['lease']>;
};

function createLeasedRecord(
  overrides: Partial<ReviewRecord> & {
    lease: NonNullable<ReviewRecord['lease']>;
  }
): LeasedReviewRecord {
  return createRecord(overrides) as LeasedReviewRecord;
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

  it('round-trips run authorization ownership fields', async () => {
    await withTestStore(async ({ db, store }) => {
      const authorization = createAuthorization();
      await store.set(
        createRecord({
          authorization,
        }),
        { reason: 'authorized run' }
      );

      const actual = await store.get('review-1');
      expect(actual?.authorization).toEqual(authorization);
      const [row] = await db
        .select()
        .from(reviewRuns)
        .where(eq(reviewRuns.reviewId, 'review-1'));
      expect(row).toMatchObject({
        authActorType: 'serviceToken',
        authActorId: 'token-1',
        githubInstallationId: '7',
        githubRepositoryId: '42',
        githubOwner: 'octo-org',
        githubRepo: 'agent-review',
        requestHash: 'sha256:request',
      });
    });
  });

  it('stores scoped service tokens and append-only auth audit events', async () => {
    const memory = createInMemoryReviewAuthStore();
    await memory.setServiceToken(createServiceTokenRecord());
    await memory.appendAuthAuditEvent(createAuditEvent());
    await expect(memory.getServiceToken('token-1')).resolves.toMatchObject({
      tokenPrefix: 'rat_token-1',
      repository: { fullName: 'octo-org/agent-review' },
    });
    await expect(memory.listAuthAuditEvents()).resolves.toHaveLength(1);

    await withTestStore(async ({ db }) => {
      const authStore = createDrizzleReviewAuthStore(db);
      await authStore.upsertGitHubUser({
        githubUserId: '100',
        login: 'octocat',
        createdAt: BASE_TIME_MS,
        updatedAt: BASE_TIME_MS,
      });
      await authStore.upsertGitHubInstallation({
        installationId: '7',
        accountLogin: 'octo-org',
        accountType: 'Organization',
        permissions: { metadata: 'read' },
        repositorySelection: 'selected',
        createdAt: BASE_TIME_MS,
        updatedAt: BASE_TIME_MS,
      });
      await authStore.upsertGitHubRepository({
        ...createAuthorization().repository,
        createdAt: BASE_TIME_MS,
        updatedAt: BASE_TIME_MS,
      });
      await authStore.upsertGitHubRepositoryPermission({
        githubUserId: '100',
        repositoryId: '42',
        permission: 'write',
        updatedAt: BASE_TIME_MS,
      });
      await authStore.setServiceToken(createServiceTokenRecord());
      await authStore.touchServiceToken('token-1', BASE_TIME_MS + 1_000);
      await authStore.touchServiceToken('token-1', BASE_TIME_MS - 1_000);
      await authStore.appendAuthAuditEvent(createAuditEvent());

      await expect(authStore.getServiceToken('token-1')).resolves.toMatchObject(
        {
          tokenHash: 'hash',
          lastUsedAt: BASE_TIME_MS + 1_000,
          updatedAt: BASE_TIME_MS + 1_000,
        }
      );
      await expect(authStore.listAuthAuditEvents()).resolves.toEqual([
        createAuditEvent(),
      ]);
    });
  });

  it('persists runtime lease and cancellation audit fields', async () => {
    await withTestStore(async ({ store }) => {
      await store.set(
        createRecord({
          lease: {
            owner: 'review-service',
            scopeKey: 'localTrusted|codexDelegate|/repo|custom',
            acquiredAt: BASE_TIME_MS,
            heartbeatAt: BASE_TIME_MS + 500,
            expiresAt: BASE_TIME_MS + 60_000,
          },
          cancelRequestedAt: BASE_TIME_MS + 1_000,
        }),
        { reason: 'lease acquired' }
      );

      const actual = await store.get('review-1');

      expect(actual?.lease).toEqual({
        owner: 'review-service',
        scopeKey: 'localTrusted|codexDelegate|/repo|custom',
        acquiredAt: BASE_TIME_MS,
        heartbeatAt: BASE_TIME_MS + 500,
        expiresAt: BASE_TIME_MS + 60_000,
      });
      expect(actual?.cancelRequestedAt).toBe(BASE_TIME_MS + 1_000);
    });
  });

  it('reserves runtime leases with durable capacity checks', async () => {
    await withTestStore(async ({ store }) => {
      const first = createLeasedRecord({
        reviewId: 'reserved-review',
        lease: {
          owner: 'review-service',
          scopeKey: 'localTrusted|codexDelegate|/repo|custom',
          acquiredAt: BASE_TIME_MS,
          heartbeatAt: BASE_TIME_MS,
          expiresAt: BASE_TIME_MS + 60_000,
        },
      });
      const second = createLeasedRecord({
        reviewId: 'rejected-review',
        lease: {
          owner: 'review-service',
          scopeKey: 'localTrusted|codexDelegate|/repo-2|custom',
          acquiredAt: BASE_TIME_MS,
          heartbeatAt: BASE_TIME_MS,
          expiresAt: BASE_TIME_MS + 60_000,
        },
      });

      await expect(
        store.reserve(first, {
          nowMs: BASE_TIME_MS,
          maxQueuedRuns: 1,
          maxRunningRuns: 10,
          maxActiveRunsPerScope: 10,
          reason: 'reserve first',
        })
      ).resolves.toEqual({ reserved: true });
      await expect(
        store.reserve(second, {
          nowMs: BASE_TIME_MS,
          maxQueuedRuns: 1,
          maxRunningRuns: 10,
          maxActiveRunsPerScope: 10,
          reason: 'reserve second',
        })
      ).resolves.toEqual({
        reserved: false,
        reason: 'queue',
        message: 'review queue is at capacity',
      });
      await expect(store.get('rejected-review')).resolves.toBeUndefined();
    });
  });

  it('does not count queued reservations against running capacity', async () => {
    await withTestStore(async ({ store }) => {
      const request = createRequest();
      const scopeKey = runtimeScopeKeyForRequest(request);
      await expect(
        store.reserve(
          createLeasedRecord({
            reviewId: 'queued-review',
            request,
            lease: {
              owner: 'review-service',
              scopeKey,
              acquiredAt: BASE_TIME_MS,
              heartbeatAt: BASE_TIME_MS,
              expiresAt: BASE_TIME_MS + 60_000,
            },
          }),
          {
            nowMs: BASE_TIME_MS,
            maxQueuedRuns: 10,
            maxRunningRuns: 1,
            maxActiveRunsPerScope: 10,
            reason: 'reserve queued first',
          }
        )
      ).resolves.toEqual({ reserved: true });

      await expect(
        store.reserve(
          createLeasedRecord({
            reviewId: 'second-queued-review',
            request,
            lease: {
              owner: 'review-service',
              scopeKey,
              acquiredAt: BASE_TIME_MS,
              heartbeatAt: BASE_TIME_MS,
              expiresAt: BASE_TIME_MS + 60_000,
            },
          }),
          {
            nowMs: BASE_TIME_MS,
            maxQueuedRuns: 10,
            maxRunningRuns: 1,
            maxActiveRunsPerScope: 10,
            reason: 'reserve queued second',
          }
        )
      ).resolves.toEqual({ reserved: true });
    });
  });

  it('counts queued detached workflow records against execution and scope capacity', async () => {
    await withTestStore(async ({ store }) => {
      const request = createRequest();
      const scopeKey = runtimeScopeKeyForRequest(request);
      await store.set(
        createLeasedRecord({
          reviewId: 'queued-detached-review',
          request,
          detachedRunId: 'detached-queued-run',
          status: 'queued',
          lease: {
            owner: 'review-service',
            scopeKey,
            acquiredAt: BASE_TIME_MS,
            heartbeatAt: BASE_TIME_MS,
            expiresAt: BASE_TIME_MS + 60_000,
          },
        }),
        { reason: 'queued detached workflow run' }
      );

      await expect(
        store.reserve(
          createLeasedRecord({
            reviewId: 'blocked-by-detached-execution',
            request: { ...request, cwd: '/repo/other' },
            lease: {
              owner: 'review-service',
              scopeKey: 'localTrusted|codexDelegate|/repo/other|custom',
              acquiredAt: BASE_TIME_MS,
              heartbeatAt: BASE_TIME_MS,
              expiresAt: BASE_TIME_MS + 60_000,
            },
          }),
          {
            nowMs: BASE_TIME_MS,
            maxQueuedRuns: 10,
            maxRunningRuns: 1,
            maxActiveRunsPerScope: 10,
            reason: 'reserve after queued detached execution',
          }
        )
      ).resolves.toEqual({
        reserved: false,
        reason: 'running',
        message: 'review runtime concurrency is at capacity',
      });

      await expect(
        store.reserve(
          createLeasedRecord({
            reviewId: 'blocked-by-detached-scope',
            request,
            lease: {
              owner: 'review-service',
              scopeKey,
              acquiredAt: BASE_TIME_MS,
              heartbeatAt: BASE_TIME_MS,
              expiresAt: BASE_TIME_MS + 60_000,
            },
          }),
          {
            nowMs: BASE_TIME_MS,
            maxQueuedRuns: 10,
            maxRunningRuns: 10,
            maxActiveRunsPerScope: 1,
            reason: 'reserve after queued detached scope',
          }
        )
      ).resolves.toEqual({
        reserved: false,
        reason: 'scope',
        message: 'review runtime scope is at capacity',
      });
    });
  });

  it('counts leased queued reservations against scope capacity while dispatching', async () => {
    await withTestStore(async ({ store }) => {
      const request = createRequest();
      const scopeKey = runtimeScopeKeyForRequest(request);
      await expect(
        store.reserve(
          createLeasedRecord({
            reviewId: 'dispatching-queued-review',
            request,
            lease: {
              owner: 'review-service',
              scopeKey,
              acquiredAt: BASE_TIME_MS,
              heartbeatAt: BASE_TIME_MS,
              expiresAt: BASE_TIME_MS + 60_000,
            },
          }),
          {
            nowMs: BASE_TIME_MS,
            maxQueuedRuns: 10,
            maxRunningRuns: 10,
            maxActiveRunsPerScope: 1,
            reason: 'reserve dispatching queued',
          }
        )
      ).resolves.toEqual({ reserved: true });

      await expect(
        store.reserve(
          createLeasedRecord({
            reviewId: 'blocked-by-dispatching-scope',
            request,
            lease: {
              owner: 'review-service',
              scopeKey,
              acquiredAt: BASE_TIME_MS,
              heartbeatAt: BASE_TIME_MS,
              expiresAt: BASE_TIME_MS + 60_000,
            },
          }),
          {
            nowMs: BASE_TIME_MS,
            maxQueuedRuns: 10,
            maxRunningRuns: 10,
            maxActiveRunsPerScope: 1,
            reason: 'reserve after dispatching scope',
          }
        )
      ).resolves.toEqual({
        reserved: false,
        reason: 'scope',
        message: 'review runtime scope is at capacity',
      });
    });
  });

  it('counts legacy unleased and expired leased rows until reconciliation confirms terminal state', async () => {
    await withTestStore(async ({ store }) => {
      await store.set(
        createRecord({
          reviewId: 'legacy-unleased-review',
          status: 'queued',
        }),
        { reason: 'legacy active row' }
      );
      await store.set(
        createRecord({
          reviewId: 'expired-leased-review',
          status: 'running',
          lease: {
            owner: 'review-service',
            scopeKey: 'localTrusted|codexDelegate|/repo-old|custom',
            acquiredAt: BASE_TIME_MS - 60_000,
            heartbeatAt: BASE_TIME_MS - 60_000,
            expiresAt: BASE_TIME_MS - 1,
          },
        }),
        { reason: 'expired lease' }
      );

      await expect(
        store.reserve(
          createLeasedRecord({
            reviewId: 'reserved-after-legacy-queue',
            lease: {
              owner: 'review-service',
              scopeKey: 'localTrusted|codexDelegate|/repo|custom',
              acquiredAt: BASE_TIME_MS,
              heartbeatAt: BASE_TIME_MS,
              expiresAt: BASE_TIME_MS + 60_000,
            },
          }),
          {
            nowMs: BASE_TIME_MS,
            maxQueuedRuns: 1,
            maxRunningRuns: 10,
            maxActiveRunsPerScope: 10,
            reason: 'reserve after legacy queued',
          }
        )
      ).resolves.toEqual({
        reserved: false,
        reason: 'queue',
        message: 'review queue is at capacity',
      });
      await expect(
        store.reserve(
          createLeasedRecord({
            reviewId: 'reserved-after-expired-lease',
            lease: {
              owner: 'review-service',
              scopeKey: 'localTrusted|codexDelegate|/repo|custom',
              acquiredAt: BASE_TIME_MS,
              heartbeatAt: BASE_TIME_MS,
              expiresAt: BASE_TIME_MS + 60_000,
            },
          }),
          {
            nowMs: BASE_TIME_MS,
            maxQueuedRuns: 10,
            maxRunningRuns: 1,
            maxActiveRunsPerScope: 10,
            reason: 'reserve after expired lease',
          }
        )
      ).resolves.toEqual({
        reserved: false,
        reason: 'running',
        message: 'review runtime concurrency is at capacity',
      });
    });
  });

  it('ignores stale legacy unleased rows after the active upgrade-drain window', async () => {
    await withTestStore(async ({ store }) => {
      await store.set(
        createRecord({
          reviewId: 'stale-legacy-unleased-review',
          status: 'running',
          updatedAt: BASE_TIME_MS - 120_000,
        }),
        { reason: 'stale legacy active row' }
      );

      await expect(
        store.reserve(
          createLeasedRecord({
            reviewId: 'reserved-after-stale-legacy',
            lease: {
              owner: 'review-service',
              scopeKey: 'localTrusted|codexDelegate|/repo|custom',
              acquiredAt: BASE_TIME_MS,
              heartbeatAt: BASE_TIME_MS,
              expiresAt: BASE_TIME_MS + 60_000,
            },
          }),
          {
            nowMs: BASE_TIME_MS,
            legacyUnleasedActiveTtlMs: 60_000,
            maxQueuedRuns: 10,
            maxRunningRuns: 1,
            maxActiveRunsPerScope: 10,
            reason: 'reserve after stale legacy',
          }
        )
      ).resolves.toEqual({ reserved: true });
    });
  });

  it('counts fresh legacy unleased rows against reconstructed scope limits', async () => {
    await withTestStore(async ({ store }) => {
      const request = {
        ...createRequest(),
        cwd: '/repo/scope',
      };
      const scopeKey = runtimeScopeKeyForRequest(request);
      await store.set(
        createRecord({
          reviewId: 'fresh-legacy-unleased-scope',
          status: 'running',
          request,
        }),
        { reason: 'fresh legacy active row' }
      );

      await expect(
        store.reserve(
          createLeasedRecord({
            reviewId: 'blocked-by-legacy-scope',
            request,
            lease: {
              owner: 'review-service',
              scopeKey,
              acquiredAt: BASE_TIME_MS,
              heartbeatAt: BASE_TIME_MS,
              expiresAt: BASE_TIME_MS + 60_000,
            },
          }),
          {
            nowMs: BASE_TIME_MS,
            legacyUnleasedActiveTtlMs: 60_000,
            scopeKeyForRequest: runtimeScopeKeyForRequest,
            maxQueuedRuns: 10,
            maxRunningRuns: 10,
            maxActiveRunsPerScope: 1,
            reason: 'reserve after fresh legacy scope',
          }
        )
      ).resolves.toEqual({
        reserved: false,
        reason: 'scope',
        message: 'review runtime scope is at capacity',
      });
    });
  });

  it('rejects runtime reservations without a lease', async () => {
    const missingDrizzleLease = createRecord({
      reviewId: 'missing-drizzle-lease',
    }) as Parameters<TestStoreContext['store']['reserve']>[0];
    const missingMemoryLease = createRecord({
      reviewId: 'missing-memory-lease',
    }) as Parameters<
      ReturnType<typeof createInMemoryReviewStore>['reserve']
    >[0];
    const options = {
      nowMs: BASE_TIME_MS,
      maxQueuedRuns: 10,
      maxRunningRuns: 10,
      maxActiveRunsPerScope: 10,
      reason: 'missing lease',
    };
    await withTestStore(async ({ store }) => {
      await expect(store.reserve(missingDrizzleLease, options)).rejects.toThrow(
        'runtime reservation requires a lease'
      );
    });
    const store = createInMemoryReviewStore();
    await expect(store.reserve(missingMemoryLease, options)).rejects.toThrow(
      'runtime reservation requires a lease'
    );
  });

  it('does not overwrite terminal rows with stale active writes', async () => {
    await withTestStore(async ({ store }) => {
      const request = createRequest();
      await store.set(
        createRecord({
          reviewId: 'monotonic-review',
          status: 'running',
          request,
          lease: {
            owner: 'review-service',
            scopeKey: 'localTrusted|codexDelegate|/repo|custom',
            acquiredAt: BASE_TIME_MS,
            heartbeatAt: BASE_TIME_MS,
            expiresAt: BASE_TIME_MS + 60_000,
          },
        }),
        { reason: 'running' }
      );
      await store.set(
        createRecord({
          reviewId: 'monotonic-review',
          status: 'completed',
          request,
          updatedAt: BASE_TIME_MS + 1_000,
          result: createReviewResult(request),
          retentionExpiresAt: BASE_TIME_MS + 60_000,
        }),
        { reason: 'completed' }
      );
      await store.set(
        createRecord({
          reviewId: 'monotonic-review',
          status: 'running',
          request,
          updatedAt: BASE_TIME_MS + 2_000,
          lease: {
            owner: 'review-service',
            scopeKey: 'localTrusted|codexDelegate|/repo|custom',
            acquiredAt: BASE_TIME_MS,
            heartbeatAt: BASE_TIME_MS + 2_000,
            expiresAt: BASE_TIME_MS + 62_000,
          },
        }),
        { reason: 'stale running sync' }
      );
      await store.appendEvent(
        createRecord({
          reviewId: 'monotonic-review',
          status: 'failed',
          request,
          updatedAt: BASE_TIME_MS + 3_000,
          error: 'runtime lease expired',
        }),
        {
          ...createEvent('monotonic-review', 4, 'runtime lease expired'),
          type: 'failed',
          message: 'runtime lease expired',
        },
        { maxEvents: 10, reason: 'stale failed event' }
      );

      await expect(store.get('monotonic-review')).resolves.toMatchObject({
        status: 'completed',
        retentionExpiresAt: BASE_TIME_MS + 60_000,
        events: [],
      });
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

  it('keeps durable appendEvent from mutating newer terminal rows', async () => {
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
      expect(actual?.events.map((event) => event.meta.eventId)).toEqual([]);
    });
  });

  it('keeps in-memory appendEvent from mutating newer terminal rows', async () => {
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
    expect(actual?.events.map((event) => event.meta.eventId)).toEqual([]);
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

  it('requires durable auth storage in production unless fallback is explicit', () => {
    expect(() =>
      createReviewAuthStoreFromEnv({
        NODE_ENV: 'production',
        REVIEW_SERVICE_STORAGE: 'memory',
      })
    ).toThrow(/DATABASE_URL or POSTGRES_URL/);
    expect(
      createReviewAuthStoreFromEnv(
        {
          NODE_ENV: 'production',
          REVIEW_SERVICE_STORAGE: 'memory',
        },
        { allowInMemoryFallback: true }
      )
    ).toBeDefined();
  });

  it('upgrades existing initial-schema databases with runtime control columns', async () => {
    const client = new PGlite();
    await client.waitReady;
    try {
      await client.exec(await readInitialMigrationSql());
      await client.exec(
        `
          INSERT INTO review_runs (
            review_id,
            run_id,
            status,
            request,
            request_summary,
            created_at,
            updated_at
          )
          VALUES (
            'legacy-review',
            'legacy-review',
            'queued',
            '{"cwd":"/repo","target":{"type":"custom","instructions":"legacy"},"provider":"codexDelegate","executionMode":"localTrusted","outputFormats":["json"]}'::jsonb,
            '{"provider":"codexDelegate","executionMode":"localTrusted","targetType":"custom","outputFormats":["json"]}'::jsonb,
            '2026-01-01T12:00:00Z',
            '2026-01-01T12:00:00Z'
          )
        `
      );
      await client.exec(await readRuntimeControlMigrationSql());
      await client.exec(await readGitHubAuthzMigrationSql());
      const db = drizzle(client, { schema });
      const store = createDrizzleReviewStore(db);

      await expect(store.get('legacy-review')).resolves.toMatchObject({
        reviewId: 'legacy-review',
        status: 'queued',
      });
      await store.set(
        createRecord({
          reviewId: 'legacy-review',
          lease: {
            owner: 'review-service',
            scopeKey: 'localTrusted|codexDelegate|/repo|custom',
            acquiredAt: BASE_TIME_MS,
            heartbeatAt: BASE_TIME_MS,
            expiresAt: BASE_TIME_MS + 60_000,
          },
        }),
        { reason: 'lease write after upgrade' }
      );
      await expect(store.get('legacy-review')).resolves.toMatchObject({
        lease: {
          owner: 'review-service',
          scopeKey: 'localTrusted|codexDelegate|/repo|custom',
        },
      });
    } finally {
      await client.close();
    }
  });

  it('publishes the manual migration through the Drizzle journal', async () => {
    const { readMigrationFiles } = await import('drizzle-orm/migrator');

    const migrations = readMigrationFiles({
      migrationsFolder: fileURLToPath(
        new URL('../../drizzle', import.meta.url)
      ),
    });

    expect(migrations).toHaveLength(3);
    expect(migrations[0]?.sql.join('\n').trim()).toBe(
      (await readInitialMigrationSql()).trim()
    );
    expect(migrations[1]?.sql.join('\n').trim()).toBe(
      (await readRuntimeControlMigrationSql()).trim()
    );
    expect(migrations[2]?.sql.join('\n').trim()).toBe(
      (await readGitHubAuthzMigrationSql()).trim()
    );
  });
});
