import type { ReviewRunResult } from '@review-agent/review-core';
import { ReviewRunCancelledError } from '@review-agent/review-core';
import type {
  ReviewAuthScope,
  ReviewProvider,
  ReviewProviderKind,
  ReviewRepositorySelection,
  ReviewRequest,
  ReviewResult,
  ReviewRunAuthorization,
  ReviewRunListResponse,
  ReviewRunSummary,
} from '@review-agent/review-types';
import type { DetachedRunRecord } from '@review-agent/review-worker';
import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryReviewAuthStore,
  createInMemoryReviewPublicationStore,
  createInMemoryReviewStore,
  createReviewServiceApp,
  createReviewServiceAuthPolicy,
  createServiceTokenCredential,
  type ReviewAuthStoreAdapter,
  type ReviewPublicationService,
  type ReviewRecord,
  type ReviewServiceDependencies,
  type ReviewServiceRunner,
  type ReviewServiceWorker,
  type ReviewStoreAdapter,
} from './index.js';

const TEST_ALLOWED_CWD_ROOTS = [process.cwd(), '/repo'];

function createTestReviewServiceApp(
  dependencies: ReviewServiceDependencies
): ReturnType<typeof createReviewServiceApp> {
  return createReviewServiceApp({
    ...dependencies,
    authMode:
      dependencies.authMode ??
      (dependencies.authPolicy ? 'required' : 'disabled'),
    config: {
      allowedCwdRoots: TEST_ALLOWED_CWD_ROOTS,
      hostedRepositoryRoots: TEST_ALLOWED_CWD_ROOTS,
      ...(dependencies.config ?? {}),
    },
  });
}

function createRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    cwd: process.cwd(),
    target: {
      type: 'custom',
      instructions: 'review this fixture',
    },
    provider: 'codexDelegate',
    executionMode: 'localTrusted',
    outputFormats: ['json'],
    ...overrides,
  };
}

function createHostedRequest(
  overrides: Partial<ReviewRequest> = {}
): ReviewRequest {
  return createRequest({
    cwd: '/repo/octo-org/agent-review',
    ...overrides,
  });
}

function createAuthorization(
  overrides: Partial<ReviewRunAuthorization> = {}
): ReviewRunAuthorization {
  const repository: ReviewRunAuthorization['repository'] = {
    provider: 'github' as const,
    repositoryId: 42,
    installationId: 7,
    owner: 'octo-org',
    name: 'agent-review',
    fullName: 'octo-org/agent-review',
    visibility: 'private' as const,
    permissions: { metadata: 'read', contents: 'read' },
  };
  return {
    principal: {
      type: 'serviceToken',
      tokenId: 'token-1',
      tokenPrefix: 'rat_token-1',
      name: 'CI',
    },
    repository,
    scopes: ['review:start', 'review:read', 'review:cancel'],
    actor: 'service-token:token-1',
    requestHash: 'sha256:request',
    authorizedAt: 1_000,
    ...overrides,
  };
}

async function createServiceTokenAuth(
  options: {
    scopes?: ReviewRunAuthorization['scopes'];
    authorization?: ReviewRunAuthorization;
    tokenId?: string;
    secret?: string;
  } = {}
): Promise<{
  authStore: ReviewAuthStoreAdapter;
  authPolicy: NonNullable<ReviewServiceDependencies['authPolicy']>;
  token: string;
}> {
  const authStore = createInMemoryReviewAuthStore();
  const authorization = options.authorization ?? createAuthorization();
  const credential = createServiceTokenCredential({
    name: 'CI',
    scopes: options.scopes ?? authorization.scopes,
    repository: authorization.repository,
    pepper: 'test-pepper',
    ...(options.tokenId ? { tokenId: options.tokenId } : {}),
    ...(options.secret ? { secret: options.secret } : {}),
    nowMs: 1_000,
  });
  await authStore.setServiceToken(credential.record);
  return {
    authStore,
    authPolicy: createReviewServiceAuthPolicy({
      store: authStore,
      serviceTokenPepper: 'test-pepper',
    }),
    token: credential.token,
  };
}

function createProvider(id: ReviewProviderKind): ReviewProvider {
  return {
    id,
    capabilities() {
      return {
        jsonSchemaOutput: true,
        reasoningControl: true,
        streaming: false,
      };
    },
    async run() {
      return {
        raw: {
          findings: [],
          overall_correctness: 'patch is correct',
          overall_explanation: 'ok',
          overall_confidence_score: 1,
        },
        text: '',
        resolvedModel: `${id}:test`,
      };
    },
  };
}

function createProviders(): Record<ReviewRequest['provider'], ReviewProvider> {
  return {
    codexDelegate: createProvider('codexDelegate'),
    openaiCompatible: createProvider('openaiCompatible'),
  };
}

type FakeReviewStore = ReviewStoreAdapter & {
  records: Map<string, ReviewRecord>;
  writes: ReviewRecord[];
  deletes: string[];
};

type FakeReviewWorker = ReviewServiceWorker & {
  started: ReviewRequest[];
  runs: Map<string, DetachedRunRecord>;
  cancelledRunIds: string[];
};

type ParsedSseEvent = {
  id?: string;
  event?: string;
  data?: unknown;
};

type SseReaderSession = {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  decoder: {
    decode(input?: Uint8Array, options?: { stream?: boolean }): string;
  };
  buffer: string;
  queuedEvents: ParsedSseEvent[];
};

function cloneRecord(record: ReviewRecord): ReviewRecord {
  return {
    ...record,
    events: record.events.map((event) => ({
      ...event,
      meta: {
        ...event.meta,
        correlation: {
          ...event.meta.correlation,
        },
      },
    })),
  };
}

function createRunSummary(record: ReviewRecord): ReviewRunSummary {
  const repository = record.authorization?.repository;
  return {
    reviewId: record.reviewId,
    status: record.status,
    request: {
      provider: record.request.provider,
      executionMode: record.request.executionMode,
      targetType: record.request.target.type,
      outputFormats: record.request.outputFormats,
      ...(record.request.model ? { model: record.request.model } : {}),
    },
    ...(repository
      ? {
          repository: {
            provider: repository.provider,
            owner: repository.owner,
            name: repository.name,
            fullName: repository.fullName,
            repositoryId: repository.repositoryId,
            installationId: repository.installationId,
            visibility: repository.visibility,
            ...(repository.pullRequestNumber
              ? { pullRequestNumber: repository.pullRequestNumber }
              : {}),
            ...(repository.ref ? { ref: repository.ref } : {}),
            ...(repository.commitSha
              ? { commitSha: repository.commitSha }
              : {}),
          },
        }
      : {}),
    ...(record.error ? { error: record.error } : {}),
    findingCount: record.result?.result.findings.length ?? 0,
    artifactFormats: record.result
      ? Object.keys(record.result.artifacts).filter(
          (format): format is 'json' | 'markdown' | 'sarif' =>
            format === 'json' || format === 'markdown' || format === 'sarif'
        )
      : [],
    publicationCount: 0,
    ...(record.result?.result.metadata.modelResolved
      ? { modelResolved: record.result.result.metadata.modelResolved }
      : {}),
    ...(record.detachedRunId ? { detachedRunId: record.detachedRunId } : {}),
    ...(record.workflowRunId ? { workflowRunId: record.workflowRunId } : {}),
    ...(record.sandboxId ? { sandboxId: record.sandboxId } : {}),
    ...(record.cancelRequestedAt === undefined
      ? {}
      : { cancelRequestedAt: record.cancelRequestedAt }),
    ...(record.status === 'completed' ||
    record.status === 'failed' ||
    record.status === 'cancelled'
      ? { completedAt: record.updatedAt }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function createDetachedRun(
  overrides: Partial<DetachedRunRecord> = {}
): DetachedRunRecord {
  return {
    runId: 'detached-run-1',
    workflowRunId: 'detached-run-1',
    status: 'running',
    startedAt: 1_000,
    ...overrides,
  };
}

function createStore(
  options: { cloneRecords?: boolean } = {}
): FakeReviewStore {
  const cloneRecords = options.cloneRecords ?? true;
  const records = new Map<string, ReviewRecord>();
  const writes: ReviewRecord[] = [];
  const deletes: string[] = [];
  const materialize = (record: ReviewRecord) =>
    cloneRecords ? cloneRecord(record) : record;

  return {
    records,
    writes,
    deletes,
    async get(reviewId) {
      const record = records.get(reviewId);
      return record ? materialize(record) : undefined;
    },
    async list(options) {
      const summaries = [...records.values()]
        .filter((record) => !options.status || record.status === options.status)
        .filter((record) => {
          if (!options.repositories || options.repositories.length === 0) {
            return true;
          }
          const repository = record.authorization?.repository;
          if (!repository) {
            return false;
          }
          return options.repositories.some(
            (filter) =>
              filter.repositoryId === repository.repositoryId ||
              (filter.installationId === repository.installationId &&
                filter.owner.toLowerCase() === repository.owner.toLowerCase() &&
                filter.name.toLowerCase() === repository.name.toLowerCase())
          );
        })
        .map((record) => createRunSummary(record))
        .filter(
          (summary) =>
            !options.cursor ||
            summary.updatedAt < options.cursor.updatedAt ||
            (summary.updatedAt === options.cursor.updatedAt &&
              summary.reviewId.localeCompare(options.cursor.reviewId) < 0)
        )
        .sort((left, right) => {
          const updatedAtCompare = right.updatedAt - left.updatedAt;
          return updatedAtCompare === 0
            ? right.reviewId.localeCompare(left.reviewId)
            : updatedAtCompare;
        });
      const runs = summaries.slice(0, options.limit);
      const last = runs.at(-1);
      return {
        runs,
        ...(summaries.length > options.limit && last
          ? {
              nextCursor: Buffer.from(
                JSON.stringify({
                  updatedAt: last.updatedAt,
                  reviewId: last.reviewId,
                }),
                'utf8'
              ).toString('base64url'),
            }
          : {}),
      };
    },
    async reserve(record, options) {
      let queued = 0;
      let running = 0;
      let scopedActive = 0;
      for (const existing of records.values()) {
        if (['completed', 'failed', 'cancelled'].includes(existing.status)) {
          continue;
        }
        if (!existing.lease) {
          const legacyActiveTtlMs = options.legacyUnleasedActiveTtlMs;
          if (existing.status !== 'queued' && existing.status !== 'running') {
            continue;
          }
          if (
            legacyActiveTtlMs !== undefined &&
            existing.updatedAt + legacyActiveTtlMs <= options.nowMs
          ) {
            continue;
          }
        }
        if (existing.status === 'queued') {
          queued += 1;
        }
        if (existing.status === 'running' || existing.detachedRunId) {
          running += 1;
        }
        if (existing.status === 'running' || existing.lease) {
          const existingScopeKey =
            existing.lease?.scopeKey ??
            options.scopeKeyForRequest?.(existing.request);
          if (existingScopeKey === record.lease.scopeKey) {
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
      const nextRecord = materialize(record);
      records.set(record.reviewId, nextRecord);
      writes.push(nextRecord);
      return { reserved: true };
    },
    async set(record) {
      const nextRecord = materialize(record);
      records.set(record.reviewId, nextRecord);
      writes.push(nextRecord);
    },
    async appendEvent(record, event, options) {
      const nextRecord = materialize(record);
      if (nextRecord.events.length >= options.maxEvents) {
        nextRecord.events.shift();
      }
      nextRecord.events.push(event);
      records.set(record.reviewId, nextRecord);
      writes.push(nextRecord);
      record.events = nextRecord.events;
    },
    async delete(reviewId) {
      records.delete(reviewId);
      deletes.push(reviewId);
    },
    async cleanup({ nowMs }) {
      const deletedReviewIds: string[] = [];
      for (const [reviewId, record] of records.entries()) {
        const explicitExpiry = record.retentionExpiresAt;
        if (
          ['completed', 'failed', 'cancelled'].includes(record.status) &&
          explicitExpiry !== undefined &&
          explicitExpiry <= nowMs
        ) {
          records.delete(reviewId);
          deletes.push(reviewId);
          deletedReviewIds.push(reviewId);
        }
      }
      return deletedReviewIds;
    },
    async entries() {
      return [...records.entries()].map(
        ([reviewId, record]) =>
          [reviewId, materialize(record)] as [string, ReviewRecord]
      );
    },
    async size() {
      return records.size;
    },
  };
}

function createThrowingStore(error = new Error('db down')): ReviewStoreAdapter {
  const fail = async () => {
    throw error;
  };
  return {
    get: fail,
    list: fail,
    reserve: fail,
    set: fail,
    appendEvent: fail,
    delete: fail,
    cleanup: fail,
    entries: fail,
    size: fail,
  };
}

function createWorker(
  run: DetachedRunRecord = createDetachedRun()
): FakeReviewWorker {
  const started: ReviewRequest[] = [];
  const runs = new Map<string, DetachedRunRecord>();
  const cancelledRunIds: string[] = [];

  return {
    started,
    runs,
    cancelledRunIds,
    async startDetached(request) {
      started.push(request);
      runs.set(run.runId, run);
      return run;
    },
    async get(runId) {
      return runs.get(runId) ?? null;
    },
    async cancel(runId) {
      const record = runs.get(runId);
      if (
        !record ||
        ['completed', 'failed', 'cancelled'].includes(record.status)
      ) {
        return false;
      }
      record.status = 'cancelled';
      record.completedAt = 1_500;
      cancelledRunIds.push(runId);
      return true;
    },
  };
}

function createUuid(values: string[]): () => string {
  return () => {
    const value = values.shift();
    if (!value) {
      throw new Error('test uuid sequence exhausted');
    }
    return value;
  };
}

function createReviewResult(request: ReviewRequest): ReviewRunResult {
  const result: ReviewResult = {
    findings: [],
    overallCorrectness: 'patch is correct',
    overallExplanation: 'ok',
    overallConfidenceScore: 1,
    metadata: {
      provider: request.provider,
      modelResolved: 'test-model',
      executionMode: request.executionMode,
      promptPack: 'test-pack',
      gitContext: {
        mode: 'custom',
      },
    },
  };

  return {
    reviewId: 'core-review-1',
    request,
    result,
    artifacts: {
      json: JSON.stringify(result),
      markdown: '# Review\n\nNo findings.',
    },
    diff: {
      patch: '',
      chunks: [],
      changedLineIndex: new Map(),
      gitContext: {
        mode: 'custom',
      },
    },
    prompt: 'prompt',
    rubric: 'rubric',
  };
}

function createReviewRecord(
  overrides: Partial<ReviewRecord> = {}
): ReviewRecord {
  return {
    reviewId: 'review-existing',
    status: 'queued',
    request: createRequest(),
    createdAt: 1_000,
    updatedAt: 1_000,
    events: [],
    ...overrides,
  };
}

function parseSseEventBlock(block: string): ParsedSseEvent {
  const event: ParsedSseEvent = {};
  for (const line of block.split('\n')) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }
    const field = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1).trimStart();
    if (field === 'id') {
      event.id = value;
    }
    if (field === 'event') {
      event.event = value;
    }
    if (field === 'data' && value) {
      event.data = JSON.parse(value);
    }
  }
  return event;
}

function parseSseEvents(text: string): ParsedSseEvent[] {
  return text.split('\n\n').filter(Boolean).map(parseSseEventBlock);
}

async function withTimeout<T>(
  promise: Promise<T>,
  message: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 1_000);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function readSseEvents(
  response: Response,
  expectedCount: number
): Promise<ParsedSseEvent[]> {
  expect(response.status).toBe(200);
  expect(response.body).not.toBeNull();

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('SSE response did not include a readable body');
  }

  const decoder = new TextDecoder();
  let text = '';
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { done, value } = await withTimeout(
        reader.read(),
        'timed out waiting for replayed SSE events'
      );
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
      if (text.split('\n\n').filter(Boolean).length >= expectedCount) {
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return parseSseEvents(text);
}

function createSseReaderSession(response: Response): SseReaderSession {
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('SSE response did not include a readable body');
  }
  return {
    reader,
    decoder: new TextDecoder(),
    buffer: '',
    queuedEvents: [],
  };
}

async function readNextSseEvent(
  session: SseReaderSession
): Promise<ParsedSseEvent> {
  const nextQueuedEvent = session.queuedEvents.shift();
  if (nextQueuedEvent) {
    return nextQueuedEvent;
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { done, value } = await withTimeout(
      session.reader.read(),
      'timed out waiting for SSE event'
    );
    if (done) {
      break;
    }
    session.buffer += session.decoder.decode(value, { stream: true });
    const blocks = session.buffer.split('\n\n');
    session.buffer = blocks.pop() ?? '';
    session.queuedEvents.push(
      ...blocks.filter(Boolean).map(parseSseEventBlock)
    );
    const event = session.queuedEvents.shift();
    if (event) {
      return event;
    }
  }

  throw new Error('SSE stream ended before an event was available');
}

async function readSseEventsUntilClose(
  session: SseReaderSession
): Promise<ParsedSseEvent[]> {
  const events = session.queuedEvents.splice(0);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { done, value } = await withTimeout(
      session.reader.read(),
      'timed out waiting for SSE stream close'
    );
    if (done) {
      return events;
    }
    session.buffer += session.decoder.decode(value, { stream: true });
    const blocks = session.buffer.split('\n\n');
    session.buffer = blocks.pop() ?? '';
    events.push(...blocks.filter(Boolean).map(parseSseEventBlock));
  }

  throw new Error('SSE stream did not close');
}

describe('createReviewServiceApp', () => {
  it('requires bearer authentication by default at the app boundary', async () => {
    const worker = createWorker();
    const app = createReviewServiceApp({
      providers: createProviders(),
      worker,
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest(),
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(await response.json()).toEqual({ error: 'authentication required' });
    expect(worker.started).toEqual([]);
  });

  it('runs detached reviews through injected worker without sharing state', async () => {
    const providers = createProviders();
    const worker = createWorker();
    const app = createTestReviewServiceApp({
      providers,
      worker,
      nowMs: () => 1_000,
      uuid: createUuid(['review-1', 'event-1']),
      config: { recordCleanupIntervalMs: false },
    });
    const isolatedApp = createTestReviewServiceApp({
      providers,
      worker: createWorker(),
      nowMs: () => 1_000,
      uuid: createUuid(['unused-review']),
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest(),
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      reviewId: 'review-1',
      status: 'running',
      detachedRunId: 'detached-run-1',
    });
    expect(worker.started).toHaveLength(1);

    const status = await app.request('/v1/review/review-1');
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      reviewId: 'review-1',
      status: 'running',
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    const missing = await isolatedApp.request('/v1/review/review-1');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'review not found' });
  });

  it('lists review runs newest first with compact summaries and cursors', async () => {
    const store = createStore();
    const request = createRequest({ model: 'gpt-test' });
    store.records.set(
      'review-old',
      createReviewRecord({
        reviewId: 'review-old',
        request,
        status: 'completed',
        result: createReviewResult(request),
        createdAt: 1_000,
        updatedAt: 2_000,
      })
    );
    store.records.set(
      'review-new',
      createReviewRecord({
        reviewId: 'review-new',
        request: createRequest({ provider: 'openaiCompatible' }),
        status: 'running',
        detachedRunId: 'detached-new',
        workflowRunId: 'workflow-new',
        createdAt: 3_000,
        updatedAt: 4_000,
      })
    );
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker: createWorker(),
      store,
      config: { recordCleanupIntervalMs: false },
    });

    const first = await app.request('/v1/review?limit=1');
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as ReviewRunListResponse;
    expect(firstBody.runs).toMatchObject([
      {
        reviewId: 'review-new',
        status: 'running',
        request: {
          provider: 'openaiCompatible',
          executionMode: 'localTrusted',
          targetType: 'custom',
        },
        detachedRunId: 'detached-new',
        workflowRunId: 'workflow-new',
      },
    ]);
    expect(firstBody.nextCursor).toEqual(expect.any(String));
    if (!firstBody.nextCursor) {
      throw new Error('expected run list cursor');
    }

    const second = await app.request(
      `/v1/review?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      runs: [
        {
          reviewId: 'review-old',
          status: 'completed',
          request: {
            model: 'gpt-test',
          },
          artifactFormats: ['json', 'markdown'],
          findingCount: 0,
          modelResolved: 'test-model',
        },
      ],
    });
  });

  it('filters review run lists to authenticated repository scope', async () => {
    const store = createStore();
    const authorized = createAuthorization();
    const other = createAuthorization({
      repository: {
        ...authorized.repository,
        repositoryId: 99,
        owner: 'other-org',
        name: 'other-repo',
        fullName: 'other-org/other-repo',
      },
    });
    store.records.set(
      'review-visible',
      createReviewRecord({
        reviewId: 'review-visible',
        authorization: authorized,
        status: 'completed',
      })
    );
    store.records.set(
      'review-hidden',
      createReviewRecord({
        reviewId: 'review-hidden',
        authorization: other,
        status: 'completed',
      })
    );
    const { authPolicy, authStore, token } = await createServiceTokenAuth({
      scopes: ['review:read'],
      authorization: authorized,
    });
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker: createWorker(),
      store,
      authPolicy,
      authStore,
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review', {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runs: [
        {
          reviewId: 'review-visible',
          repository: {
            owner: 'octo-org',
            name: 'agent-review',
          },
        },
      ],
    });
  });

  it('persists queued detached state before dispatching workflow work', async () => {
    const store = createStore();
    let observedQueuedRecord: ReviewRecord | undefined;
    const started: ReviewRequest[] = [];
    const runs = new Map<string, DetachedRunRecord>();
    const cancelledRunIds: string[] = [];
    const worker: FakeReviewWorker = {
      started,
      runs,
      cancelledRunIds,
      async startDetached(request) {
        started.push(request);
        observedQueuedRecord = await store.get('review-durable-start');
        const run = createDetachedRun({
          runId: 'workflow-run-1',
          workflowRunId: 'workflow-run-1',
        });
        runs.set(run.runId, run);
        return run;
      },
      async get(runId) {
        return runs.get(runId) ?? null;
      },
      async cancel(runId) {
        cancelledRunIds.push(runId);
        return true;
      },
    };
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      nowMs: () => 1_250,
      uuid: createUuid(['review-durable-start', 'event-start']),
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest(),
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(202);
    expect(observedQueuedRecord).toMatchObject({
      reviewId: 'review-durable-start',
      status: 'queued',
    });
    await expect(store.get('review-durable-start')).resolves.toMatchObject({
      detachedRunId: 'workflow-run-1',
      workflowRunId: 'workflow-run-1',
      status: 'running',
    });
  });

  it('marks detached start failures as durable failed records', async () => {
    const store = createStore();
    const worker = createWorker();
    const secret = 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456';
    worker.startDetached = vi.fn(async () => {
      throw new Error(`workflow start unavailable ${secret}`);
    });
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      nowMs: () => 1_500,
      uuid: createUuid(['review-start-failed']),
      logger: { error: vi.fn() },
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest(),
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'failed to start review' });
    const failedRecord = await store.get('review-start-failed');
    expect(failedRecord).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('[REDACTED_SECRET]'),
      retentionExpiresAt: 3_601_500,
    });
    expect(JSON.stringify(failedRecord)).not.toContain(
      'sk-abcdefghijklmnopqrstuvwxyz123456'
    );
    expect(failedRecord?.events.map((event) => event.type)).toEqual(['failed']);
  });

  it('emits terminal events when workflow completion is visible at start', async () => {
    const request = createRequest();
    const result = createReviewResult(request);
    const worker = createWorker();
    worker.startDetached = vi.fn(async () =>
      createDetachedRun({
        runId: 'workflow-run-terminal',
        workflowRunId: 'workflow-run-terminal',
        status: 'completed',
        completedAt: 1_250,
        result,
      })
    );
    const store = createStore();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      nowMs: () => 1_250,
      uuid: createUuid(['review-terminal-start', 'event-start']),
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request,
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      reviewId: 'review-terminal-start',
      status: 'completed',
      detachedRunId: 'workflow-run-terminal',
    });
    const completedRecord = await store.get('review-terminal-start');
    expect(completedRecord).toMatchObject({
      status: 'completed',
      retentionExpiresAt: 3_601_250,
    });
    expect(completedRecord?.events.map((event) => event.type)).toEqual([
      'enteredReviewMode',
      'exitedReviewMode',
      'artifactReady',
      'artifactReady',
    ]);
  });

  it('persists terminal detached start events in the exported stores', async () => {
    const request = createRequest();
    const result = createReviewResult(request);
    const worker = createWorker(
      createDetachedRun({
        runId: 'workflow-run-terminal-store',
        workflowRunId: 'workflow-run-terminal-store',
        status: 'completed',
        completedAt: 1_250,
        result,
      })
    );
    const store = createInMemoryReviewStore();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      nowMs: () => 1_250,
      uuid: createUuid([
        'review-terminal-store',
        'event-start',
        'event-exited',
        'event-artifact-json',
        'event-artifact-markdown',
      ]),
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request,
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(202);
    await expect(store.get('review-terminal-store')).resolves.toMatchObject({
      status: 'completed',
      events: [
        expect.objectContaining({ type: 'enteredReviewMode' }),
        expect.objectContaining({ type: 'exitedReviewMode' }),
        expect.objectContaining({ type: 'artifactReady', format: 'json' }),
        expect.objectContaining({ type: 'artifactReady', format: 'markdown' }),
      ],
    });
  });

  it('syncs detached completion into status and artifact routes', async () => {
    const worker = createWorker();
    const store = createStore();
    const request = createRequest();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      nowMs: () => 1_000,
      uuid: createUuid([
        'review-detached',
        'event-start',
        'event-exited',
        'event-artifact-json',
        'event-artifact-markdown',
      ]),
      config: { recordCleanupIntervalMs: false },
    });

    const start = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request,
        delivery: 'detached',
      }),
    });

    expect(start.status).toBe(202);
    const run = worker.runs.get('detached-run-1');
    expect(run).toBeDefined();
    if (!run) {
      throw new Error('detached run was not started');
    }
    run.status = 'completed';
    run.completedAt = 2_000;
    run.result = createReviewResult(request);

    const artifact = await app.request(
      '/v1/review/review-detached/artifacts/markdown'
    );
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get('content-type')).toBe(
      'text/markdown; charset=utf-8'
    );
    expect(await artifact.text()).toBe('# Review\n\nNo findings.');

    const status = await app.request('/v1/review/review-detached');
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      reviewId: 'review-detached',
      status: 'completed',
      summary: {
        reviewId: 'review-detached',
        status: 'completed',
        artifactFormats: ['json', 'markdown'],
        findingCount: 0,
        publicationCount: 0,
      },
      artifacts: [
        {
          reviewId: 'review-detached',
          format: 'json',
          contentType: 'application/json; charset=utf-8',
        },
        {
          reviewId: 'review-detached',
          format: 'markdown',
          contentType: 'text/markdown; charset=utf-8',
        },
      ],
      result: {
        overallCorrectness: 'patch is correct',
      },
    });
    await expect(store.get('review-detached')).resolves.toMatchObject({
      status: 'completed',
      retentionExpiresAt: 3_601_000,
    });
    const completedRecord = await store.get('review-detached');
    expect(completedRecord?.events.map((event) => event.type)).toEqual([
      'enteredReviewMode',
      'exitedReviewMode',
      'artifactReady',
      'artifactReady',
    ]);

    const repeatedStatus = await app.request('/v1/review/review-detached');
    expect(repeatedStatus.status).toBe(200);
    const repeatedRecord = await store.get('review-detached');
    expect(repeatedRecord?.events.map((event) => event.type)).toEqual([
      'enteredReviewMode',
      'exitedReviewMode',
      'artifactReady',
      'artifactReady',
    ]);
  });

  it('runs inline reviews through the injected runner and serves artifacts', async () => {
    const providers = createProviders();
    const worker = createWorker();
    const store = createStore();
    const secret = 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456';
    const request = createRequest({
      target: {
        type: 'custom',
        instructions: `review this fixture\n${secret}`,
      },
    });
    const bridge = {
      mirrorWrite: vi.fn(async () => true),
    };
    const runner = vi.fn<ReviewServiceRunner>(async (request) =>
      createReviewResult(request)
    );
    const app = createTestReviewServiceApp({
      providers,
      worker,
      bridge,
      store,
      runner,
      nowMs: () => 2_000,
      uuid: createUuid(['review-inline', 'event-progress']),
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request,
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      reviewId: 'review-inline',
      status: 'completed',
      result: {
        findings: [],
        overallCorrectness: 'patch is correct',
      },
    });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]?.[0].target).toMatchObject({
      type: 'custom',
      instructions: expect.stringContaining(secret),
    });
    expect(runner.mock.calls[0]?.[1].providers).toBe(providers);
    expect(runner.mock.calls[0]?.[2]).toBe(bridge);
    const stored = await store.get('review-inline');
    const serializedStored = JSON.stringify(stored);
    expect(serializedStored).not.toContain(
      'sk-abcdefghijklmnopqrstuvwxyz123456'
    );
    expect(serializedStored).toContain('[REDACTED_SECRET]');

    const artifact = await app.request(
      '/v1/review/review-inline/artifacts/json'
    );
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get('content-type')).toBe(
      'application/json; charset=utf-8'
    );
    expect(await artifact.json()).toMatchObject({
      overallCorrectness: 'patch is correct',
    });

    const missingArtifact = await app.request(
      '/v1/review/review-inline/artifacts/sarif'
    );
    expect(missingArtifact.status).toBe(404);
    expect(await missingArtifact.json()).toEqual({
      error: 'artifact format sarif not generated',
    });

    const invalidArtifact = await app.request(
      '/v1/review/review-inline/artifacts/xml'
    );
    expect(invalidArtifact.status).toBe(400);
    expect(await invalidArtifact.json()).toEqual({
      error: 'invalid artifact format',
    });
  });

  it('publishes completed GitHub reviews through the injected publication service', async () => {
    const authorization = createAuthorization({
      scopes: ['review:start', 'review:read', 'review:publish'],
      repository: {
        ...createAuthorization().repository,
        pullRequestNumber: 25,
      },
    });
    const { authPolicy, authStore, token } = await createServiceTokenAuth({
      authorization,
      scopes: authorization.scopes,
    });
    const store = createStore();
    const request = createHostedRequest();
    const completed = createReviewRecord({
      reviewId: 'review-publish',
      status: 'completed',
      request,
      authorization,
      result: createReviewResult(request),
    });
    store.records.set(completed.reviewId, completed);
    const publicationService: ReviewPublicationService = {
      publish: vi.fn(async () => ({
        reviewId: 'review-publish',
        status: 'published' as const,
        publications: [
          {
            publicationId: 'review-publish:checkRun:1',
            reviewId: 'review-publish',
            channel: 'checkRun' as const,
            targetKey: 'check-run:abcdef1',
            status: 'published' as const,
            externalId: '100',
            createdAt: 1_000,
            updatedAt: 1_000,
          },
        ],
      })),
    };
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker: createWorker(),
      store,
      authPolicy,
      authStore,
      publicationService,
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/review-publish/publish', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      reviewId: 'review-publish',
      status: 'published',
      publications: [{ channel: 'checkRun', status: 'published' }],
    });
    expect(publicationService.publish).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: 'review-publish' })
    );
  });

  it('rejects publication for unfinished runs before GitHub side effects', async () => {
    const authorization = createAuthorization({
      scopes: ['review:start', 'review:read', 'review:publish'],
    });
    const { authPolicy, authStore, token } = await createServiceTokenAuth({
      authorization,
      scopes: authorization.scopes,
    });
    const store = createStore();
    store.records.set(
      'review-not-ready',
      createReviewRecord({
        reviewId: 'review-not-ready',
        status: 'running',
        authorization,
      })
    );
    const publicationService: ReviewPublicationService = {
      publish: vi.fn(async () => {
        throw new Error('should not publish');
      }),
    };
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker: createWorker(),
      store,
      authPolicy,
      authStore,
      publicationService,
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/review-not-ready/publish', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'review is not ready to publish',
    });
    expect(publicationService.publish).not.toHaveBeenCalled();
  });

  it('exposes durable publication state in status responses', async () => {
    const store = createStore();
    const publicationStore = createInMemoryReviewPublicationStore();
    const request = createRequest();
    store.records.set(
      'review-with-publication',
      createReviewRecord({
        reviewId: 'review-with-publication',
        status: 'completed',
        request,
        result: createReviewResult(request),
      })
    );
    await publicationStore.upsert({
      publicationId: 'publication-1',
      reviewId: 'review-with-publication',
      channel: 'sarif',
      targetKey: 'sarif:abcdef1:refs/heads/main',
      status: 'unsupported',
      message: 'code scanning unavailable',
      createdAt: 1_000,
      updatedAt: 1_500,
    });
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker: createWorker(),
      store,
      publicationStore,
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/review-with-publication');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      reviewId: 'review-with-publication',
      publications: [
        {
          channel: 'sarif',
          status: 'unsupported',
          message: 'code scanning unavailable',
        },
      ],
    });
  });

  it('refreshes inline leases while provider work is still running', async () => {
    const store = createStore();
    let currentTime = 1_000;
    let releaseRunner: (() => void) | undefined;
    const runnerReleased = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    let resolveHeartbeatObserved: () => void = () => undefined;
    const heartbeatObserved = new Promise<void>((resolve) => {
      resolveHeartbeatObserved = resolve;
    });
    const runner = vi.fn<ReviewServiceRunner>(async (request, options) => {
      currentTime = 1_300;
      await options.onEvent?.({
        type: 'progress',
        message: 'provider still running',
        meta: {
          eventId: 'provider-progress-event',
          timestampMs: currentTime,
          correlation: {
            reviewId: 'provider-review',
          },
        },
      });
      resolveHeartbeatObserved();
      await runnerReleased;
      return createReviewResult(request);
    });
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker: createWorker(),
      store,
      runner,
      nowMs: () => currentTime,
      uuid: createUuid([
        'review-inline-heartbeat',
        'event-start',
        'event-provider',
      ]),
      config: {
        runtimeLeaseTtlMs: 500,
        recordCleanupIntervalMs: false,
      },
    });

    const start = app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest(),
      }),
    });
    await heartbeatObserved;

    const runningRecord = await store.get('review-inline-heartbeat');
    expect(runningRecord?.lease).toMatchObject({
      heartbeatAt: 1_300,
      expiresAt: 1_800,
    });

    releaseRunner?.();
    expect((await start).status).toBe(200);
  });

  it('records inline cancellation as cancelled instead of failed', async () => {
    const runner = vi.fn<ReviewServiceRunner>(async () => {
      throw new ReviewRunCancelledError('user requested cancellation');
    });
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker: createWorker(),
      runner,
      nowMs: () => 2_250,
      uuid: createUuid(['review-inline-cancel', 'event-start', 'event-cancel']),
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest(),
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      reviewId: 'review-inline-cancel',
      status: 'cancelled',
    });

    const events = await readSseEvents(
      await app.request('/v1/review/review-inline-cancel/events'),
      2
    );
    expect(events.map((event) => event.event)).toEqual([
      'progress',
      'cancelled',
    ]);
  });

  it('records inline failures and replays lifecycle events deterministically', async () => {
    const runner = vi.fn<ReviewServiceRunner>(async () => {
      throw new Error('provider fixture failed');
    });
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker: createWorker(),
      runner,
      nowMs: () => 3_000,
      uuid: createUuid(['review-failed', 'event-progress', 'event-failed']),
      config: { recordCleanupIntervalMs: false },
    });

    const start = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest(),
      }),
    });

    expect(start.status).toBe(200);
    expect(await start.json()).toEqual({
      reviewId: 'review-failed',
      status: 'failed',
    });

    const status = await app.request('/v1/review/review-failed');
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      reviewId: 'review-failed',
      status: 'failed',
      error: 'provider fixture failed',
    });

    const events = await readSseEvents(
      await app.request('/v1/review/review-failed/events'),
      2
    );
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.event)).toEqual(['progress', 'failed']);
    expect(events[1]?.data).toMatchObject({
      type: 'failed',
      message: 'provider fixture failed',
      meta: {
        correlation: {
          reviewId: 'review-failed',
        },
      },
    });
  });

  it('redacts inline failure details before storing status and events', async () => {
    const secret =
      'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456 Bearer abc.def.ghi';
    const runner = vi.fn<ReviewServiceRunner>(async () => {
      throw new Error(`provider fixture failed ${secret}`);
    });
    const store = createStore();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker: createWorker(),
      store,
      runner,
      nowMs: () => 3_100,
      uuid: createUuid([
        'review-redacted-failed',
        'event-progress',
        'event-failed',
      ]),
      config: { recordCleanupIntervalMs: false },
    });

    const start = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest(),
      }),
    });

    expect(start.status).toBe(200);
    const record = await store.get('review-redacted-failed');
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(serialized).not.toContain('abc.def.ghi');
    expect(record?.error).toContain('[REDACTED_SECRET]');
    expect(record?.events.at(-1)).toMatchObject({
      type: 'failed',
      message: expect.stringContaining('[REDACTED_SECRET]'),
    });
  });

  it('replays lifecycle events after the requested cursor', async () => {
    const runner = vi.fn<ReviewServiceRunner>(async () => {
      throw new Error('provider fixture failed');
    });
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker: createWorker(),
      runner,
      nowMs: () => 3_250,
      uuid: createUuid(['review-cursor', 'event-progress', 'event-failed']),
      config: { recordCleanupIntervalMs: false },
    });

    const start = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest(),
      }),
    });
    expect(start.status).toBe(200);

    const events = await readSseEvents(
      await app.request(
        '/v1/review/review-cursor/events?afterEventId=event-progress&limit=1'
      ),
      1
    );

    expect(events.map((event) => event.event)).toEqual(['failed']);
    expect(events[0]?.id).toBe('event-failed');

    const reconnectEvents = await readSseEvents(
      await app.request('/v1/review/review-cursor/events', {
        headers: {
          'Last-Event-ID': 'event-progress',
        },
      }),
      1
    );

    expect(reconnectEvents.map((event) => event.event)).toEqual(['failed']);
  });

  it('syncs detached failures into status and lifecycle replay', async () => {
    const worker = createWorker();
    const store = createStore();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      nowMs: () => 3_500,
      uuid: createUuid([
        'review-detached-failed',
        'event-start',
        'event-failed',
      ]),
      config: { recordCleanupIntervalMs: false },
    });

    const start = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest(),
        delivery: 'detached',
      }),
    });

    expect(start.status).toBe(202);
    const run = worker.runs.get('detached-run-1');
    expect(run).toBeDefined();
    if (!run) {
      throw new Error('detached run was not started');
    }
    run.status = 'failed';
    run.error = 'detached fixture failed';
    run.completedAt = 3_500;

    const status = await app.request('/v1/review/review-detached-failed');
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      reviewId: 'review-detached-failed',
      status: 'failed',
      error: 'detached fixture failed',
    });

    const events = await readSseEvents(
      await app.request('/v1/review/review-detached-failed/events'),
      2
    );
    expect(events.map((event) => event.event)).toEqual([
      'enteredReviewMode',
      'failed',
    ]);
    expect(events[1]?.data).toMatchObject({
      type: 'failed',
      message: 'detached fixture failed',
      meta: {
        correlation: {
          reviewId: 'review-detached-failed',
          workflowRunId: 'detached-run-1',
        },
      },
    });
  });

  it('streams detached terminal events to already-open SSE connections', async () => {
    const worker = createWorker();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store: createStore(),
      nowMs: () => 3_750,
      uuid: createUuid(['review-live-failed', 'event-start', 'event-failed']),
      config: {
        eventStreamPollIntervalMs: 10,
        recordCleanupIntervalMs: false,
      },
    });

    const start = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest(),
        delivery: 'detached',
      }),
    });
    expect(start.status).toBe(202);

    const eventsResponse = await app.request(
      '/v1/review/review-live-failed/events'
    );
    const session = createSseReaderSession(eventsResponse);

    try {
      await expect(readNextSseEvent(session)).resolves.toMatchObject({
        event: 'enteredReviewMode',
      });

      const run = worker.runs.get('detached-run-1');
      expect(run).toBeDefined();
      if (!run) {
        throw new Error('detached run was not started');
      }
      run.status = 'failed';
      run.error = 'detached live failure';
      run.completedAt = 3_750;

      await expect(readNextSseEvent(session)).resolves.toMatchObject({
        event: 'failed',
        data: {
          type: 'failed',
          message: 'detached live failure',
          meta: {
            correlation: {
              reviewId: 'review-live-failed',
              workflowRunId: 'detached-run-1',
            },
          },
        },
      });
    } finally {
      await session.reader.cancel().catch(() => undefined);
    }
  });

  it('cancels detached runs and replays terminal lifecycle state', async () => {
    const worker = createWorker();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      nowMs: () => 4_000,
      uuid: createUuid(['review-cancel', 'event-start', 'event-cancel']),
      config: { recordCleanupIntervalMs: false },
    });

    const start = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest(),
        delivery: 'detached',
      }),
    });

    expect(start.status).toBe(202);

    const cancel = await app.request('/v1/review/review-cancel/cancel', {
      method: 'POST',
    });
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toEqual({
      reviewId: 'review-cancel',
      status: 'cancelled',
    });
    expect(worker.cancelledRunIds).toEqual(['detached-run-1']);

    const repeatedCancel = await app.request(
      '/v1/review/review-cancel/cancel',
      {
        method: 'POST',
      }
    );
    expect(repeatedCancel.status).toBe(409);
    expect(await repeatedCancel.json()).toEqual({
      reviewId: 'review-cancel',
      status: 'cancelled',
      cancelled: false,
    });

    const events = await readSseEvents(
      await app.request('/v1/review/review-cancel/events'),
      2
    );
    expect(events.map((event) => event.event)).toEqual([
      'enteredReviewMode',
      'cancelled',
    ]);
    expect(events[1]?.data).toMatchObject({
      type: 'cancelled',
      meta: {
        correlation: {
          reviewId: 'review-cancel',
          workflowRunId: 'detached-run-1',
        },
      },
    });
  });

  it('keeps detached cancel requests nonterminal until the worker reports cancelled', async () => {
    const worker = createWorker();
    worker.cancel = vi.fn(async (runId) => {
      worker.cancelledRunIds.push(runId);
      return true;
    });
    const store = createStore();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      nowMs: () => 4_100,
      uuid: createUuid(['review-cancel-pending', 'event-start']),
      config: { recordCleanupIntervalMs: false },
    });

    const start = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest(),
        delivery: 'detached',
      }),
    });
    expect(start.status).toBe(202);

    const cancel = await app.request(
      '/v1/review/review-cancel-pending/cancel',
      { method: 'POST' }
    );

    expect(cancel.status).toBe(202);
    expect(await cancel.json()).toEqual({
      reviewId: 'review-cancel-pending',
      status: 'running',
      cancelled: false,
    });
    expect(worker.cancelledRunIds).toEqual(['detached-run-1']);
    const record = await store.get('review-cancel-pending');
    expect(record).toMatchObject({
      status: 'running',
      cancelRequestedAt: 4_100,
    });
    expect(record?.lease).toBeDefined();
  });

  it('does not poison cancel retries after transient worker cancellation failures', async () => {
    const worker = createWorker();
    let cancelAttempts = 0;
    worker.cancel = vi.fn(async (runId) => {
      cancelAttempts += 1;
      if (cancelAttempts === 1) {
        throw new Error('workflow cancel unavailable');
      }
      worker.cancelledRunIds.push(runId);
      return true;
    });
    const store = createStore();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      logger: { error: vi.fn() },
      nowMs: () => 4_100,
      uuid: createUuid(['review-cancel-retry', 'event-start']),
      config: { recordCleanupIntervalMs: false },
    });

    const start = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest(),
        delivery: 'detached',
      }),
    });
    expect(start.status).toBe(202);

    const firstCancel = await app.request(
      '/v1/review/review-cancel-retry/cancel',
      { method: 'POST' }
    );
    expect(firstCancel.status).toBe(502);
    await expect(store.get('review-cancel-retry')).resolves.toMatchObject({
      status: 'running',
    });
    expect((await store.get('review-cancel-retry'))?.cancelRequestedAt).toBe(
      undefined
    );

    const retryCancel = await app.request(
      '/v1/review/review-cancel-retry/cancel',
      { method: 'POST' }
    );

    expect(retryCancel.status).toBe(202);
    expect(await retryCancel.json()).toEqual({
      reviewId: 'review-cancel-retry',
      status: 'running',
      cancelled: false,
    });
    expect(worker.cancelledRunIds).toEqual(['detached-run-1']);
    await expect(store.get('review-cancel-retry')).resolves.toMatchObject({
      cancelRequestedAt: 4_100,
    });
  });

  it('returns conflict when Workflow finishes before cancel reconciliation', async () => {
    const worker = createWorker();
    worker.cancel = vi.fn(async (runId) => {
      const run = worker.runs.get(runId);
      if (run) {
        run.status = 'completed';
        run.completedAt = 4_200;
        run.result = createReviewResult(run.result?.request ?? createRequest());
      }
      worker.cancelledRunIds.push(runId);
      return true;
    });
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      nowMs: () => 4_200,
      uuid: createUuid([
        'review-cancel-completed',
        'event-start',
        'event-exited',
        'event-artifact-json',
      ]),
      config: { recordCleanupIntervalMs: false },
    });

    const start = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest(),
        delivery: 'detached',
      }),
    });
    expect(start.status).toBe(202);

    const cancel = await app.request(
      '/v1/review/review-cancel-completed/cancel',
      { method: 'POST' }
    );

    expect(cancel.status).toBe(409);
    expect(await cancel.json()).toEqual({
      reviewId: 'review-cancel-completed',
      status: 'completed',
      cancelled: false,
    });
  });

  it('rejects new runs when the runtime queue is at capacity', async () => {
    const store = createStore();
    const request = createRequest();
    await store.set(
      createReviewRecord({
        reviewId: 'review-queued',
        status: 'queued',
        request,
        lease: {
          owner: 'test',
          scopeKey: 'different-scope',
          acquiredAt: 1_000,
          heartbeatAt: 1_000,
          expiresAt: 10_000,
        },
      })
    );
    const worker = createWorker();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      nowMs: () => 2_000,
      uuid: createUuid(['unused-review-id']),
      config: {
        maxQueuedRuns: 1,
        recordCleanupIntervalMs: false,
      },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request,
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(await response.json()).toEqual({
      error: 'review queue is at capacity',
    });
    expect(worker.started).toEqual([]);
  });

  it('atomically reserves runtime capacity under concurrent starts', async () => {
    const store = createInMemoryReviewStore();
    let releaseStart: (() => void) | undefined;
    let resolveFirstStartEntered: () => void = () => undefined;
    const firstStartEntered = new Promise<void>((resolve) => {
      resolveFirstStartEntered = resolve;
    });
    const worker = createWorker();
    worker.startDetached = vi.fn(async (request) => {
      worker.started.push(request);
      if (worker.started.length === 1) {
        resolveFirstStartEntered();
      }
      await new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      const run = createDetachedRun({
        runId: `detached-run-${worker.started.length}`,
        workflowRunId: `detached-run-${worker.started.length}`,
      });
      worker.runs.set(run.runId, run);
      return run;
    });
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      nowMs: () => 2_000,
      uuid: createUuid(['review-a', 'review-b', 'event-start']),
      config: {
        maxQueuedRuns: 1,
        recordCleanupIntervalMs: false,
      },
    });

    const first = app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest({ cwd: '/repo/concurrent-a' }),
        delivery: 'detached',
      }),
    });
    await firstStartEntered;
    const second = app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest({ cwd: '/repo/concurrent-b' }),
        delivery: 'detached',
      }),
    });

    const rejected = await second;
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toEqual({
      error: 'review queue is at capacity',
    });

    releaseStart?.();
    const accepted = await first;
    expect(accepted.status).toBe(202);
    expect(worker.started).toHaveLength(1);
  });

  it('counts active inline reservations against runtime concurrency', async () => {
    let releaseRunner: (() => void) | undefined;
    let resolveRunnerStarted: () => void = () => undefined;
    const runnerStarted = new Promise<void>((resolve) => {
      resolveRunnerStarted = resolve;
    });
    const runner = vi.fn<ReviewServiceRunner>(async (request) => {
      resolveRunnerStarted();
      await new Promise<void>((release) => {
        releaseRunner = release;
      });
      return createReviewResult(request);
    });
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker: createWorker(),
      store: createInMemoryReviewStore(),
      runner,
      config: {
        maxQueuedRuns: 10,
        maxRunningRuns: 1,
        recordCleanupIntervalMs: false,
      },
    });

    const first = app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest({ cwd: '/repo/inline-a' }),
      }),
    });
    await runnerStarted;
    const second = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest({ cwd: '/repo/inline-b' }),
      }),
    });

    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({
      error: 'review runtime concurrency is at capacity',
    });
    releaseRunner?.();
    expect((await first).status).toBe(200);
  });

  it('enforces per-scope runtime backpressure before dispatching work', async () => {
    const store = createStore();
    const request = createRequest({ cwd: '/repo/scope' });
    await store.set(
      createReviewRecord({
        reviewId: 'review-scoped-running',
        status: 'running',
        request,
        lease: {
          owner: 'test',
          scopeKey: 'localTrusted|codexDelegate|/repo/scope|custom',
          acquiredAt: 1_000,
          heartbeatAt: 1_000,
          expiresAt: 10_000,
        },
      })
    );
    const worker = createWorker();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      nowMs: () => 2_000,
      config: {
        maxActiveRunsPerScope: 1,
        recordCleanupIntervalMs: false,
      },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request,
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: 'review runtime scope is at capacity',
    });
    expect(worker.started).toEqual([]);
  });

  it('canonicalizes cwd aliases before per-scope runtime backpressure', async () => {
    const store = createStore();
    const request = createRequest({ cwd: '/repo/.' });
    await store.set(
      createReviewRecord({
        reviewId: 'review-scoped-alias',
        status: 'running',
        request: createRequest({ cwd: '/repo' }),
        lease: {
          owner: 'test',
          scopeKey: 'localTrusted|codexDelegate|/repo|custom',
          acquiredAt: 1_000,
          heartbeatAt: 1_000,
          expiresAt: 10_000,
        },
      })
    );
    const worker = createWorker();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      nowMs: () => 2_000,
      config: {
        maxActiveRunsPerScope: 1,
        recordCleanupIntervalMs: false,
      },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request,
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: 'review runtime scope is at capacity',
    });
    expect(worker.started).toEqual([]);
  });

  it('enforces per-scope runtime backpressure for queued detached workflow runs', async () => {
    const worker = createWorker(
      createDetachedRun({ status: 'queued', runId: 'detached-queued-run' })
    );
    const request = createRequest({ cwd: '/repo/detached-scope' });
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store: createStore(),
      nowMs: () => 2_000,
      uuid: createUuid([
        'review-first-detached',
        'event-start',
        'review-second-detached',
      ]),
      config: {
        maxActiveRunsPerScope: 1,
        recordCleanupIntervalMs: false,
      },
    });

    const first = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request,
        delivery: 'detached',
      }),
    });
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({
      reviewId: 'review-first-detached',
      status: 'queued',
      detachedRunId: 'detached-queued-run',
    });

    const second = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request,
        delivery: 'detached',
      }),
    });

    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({
      error: 'review runtime scope is at capacity',
    });
    expect(worker.started).toHaveLength(1);
  });

  it('blocks concurrent same-scope detached dispatches before worker acceptance', async () => {
    let releaseStart: (() => void) | undefined;
    let resolveFirstStartEntered: () => void = () => undefined;
    const firstStartEntered = new Promise<void>((resolve) => {
      resolveFirstStartEntered = resolve;
    });
    const worker = createWorker();
    worker.startDetached = vi.fn(async (request) => {
      worker.started.push(request);
      if (worker.started.length === 1) {
        resolveFirstStartEntered();
      }
      await new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      const run = createDetachedRun({
        runId: `detached-run-${worker.started.length}`,
        workflowRunId: `detached-run-${worker.started.length}`,
      });
      worker.runs.set(run.runId, run);
      return run;
    });
    const request = createRequest({ cwd: '/repo/concurrent-scope' });
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store: createInMemoryReviewStore(),
      nowMs: () => 2_000,
      uuid: createUuid(['review-a', 'review-b', 'event-start']),
      config: {
        maxQueuedRuns: 10,
        maxRunningRuns: 10,
        maxActiveRunsPerScope: 1,
        recordCleanupIntervalMs: false,
      },
    });

    const first = app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request,
        delivery: 'detached',
      }),
    });
    await firstStartEntered;
    const second = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request,
        delivery: 'detached',
      }),
    });

    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({
      error: 'review runtime scope is at capacity',
    });
    expect(worker.started).toHaveLength(1);

    releaseStart?.();
    const accepted = await first;
    expect(accepted.status).toBe(202);
  });

  it('reconciles detached completion after lease TTL before expiring the lease', async () => {
    const request = createRequest();
    const worker = createWorker();
    const store = createStore();
    let currentTime = 1_000;
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      nowMs: () => currentTime,
      uuid: createUuid([
        'review-late-complete',
        'event-start',
        'event-exited',
        'event-artifact-json',
      ]),
      config: {
        runtimeLeaseTtlMs: 500,
        recordCleanupIntervalMs: false,
      },
    });

    const start = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request,
        delivery: 'detached',
      }),
    });
    expect(start.status).toBe(202);

    const run = worker.runs.get('detached-run-1');
    expect(run).toBeDefined();
    if (!run) {
      throw new Error('detached run was not started');
    }
    run.status = 'completed';
    run.completedAt = 2_000;
    run.result = createReviewResult(request);
    currentTime = 2_000;

    const response = await app.request('/v1/review/review-late-complete');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      reviewId: 'review-late-complete',
      status: 'completed',
    });
    const completedRecord = await store.get('review-late-complete');
    expect(completedRecord?.lease).toBeUndefined();
    expect(completedRecord?.error).toBeUndefined();
  });

  it('requests cancellation and keeps capacity for expired detached nonterminal runs', async () => {
    const request = createRequest({ cwd: '/repo/live-detached' });
    const worker = createWorker();
    const store = createStore();
    let currentTime = 1_000;
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      nowMs: () => currentTime,
      uuid: createUuid([
        'review-live-detached',
        'event-start',
        'review-capacity-check',
      ]),
      config: {
        maxRunningRuns: 1,
        runtimeLeaseTtlMs: 500,
        recordCleanupIntervalMs: false,
      },
    });

    const start = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request,
        delivery: 'detached',
      }),
    });
    expect(start.status).toBe(202);

    currentTime = 2_000;
    const status = await app.request('/v1/review/review-live-detached');
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      reviewId: 'review-live-detached',
      status: 'running',
    });
    expect(worker.cancelledRunIds).toEqual(['detached-run-1']);
    const cancellingRecord = await store.get('review-live-detached');
    expect(cancellingRecord).toMatchObject({
      status: 'running',
      cancelRequestedAt: 2_000,
      lease: {
        heartbeatAt: 2_000,
        expiresAt: 2_500,
      },
    });

    const blocked = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest({ cwd: '/repo/other-running' }),
        delivery: 'detached',
      }),
    });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({
      error: 'review runtime concurrency is at capacity',
    });
  });

  it('fails detached reviews immediately when their worker run disappears', async () => {
    const worker = createWorker();
    const store = createStore();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      nowMs: () => 2_000,
      uuid: createUuid([
        'review-missing-detached',
        'event-start',
        'event-failed',
      ]),
      config: {
        runtimeLeaseTtlMs: 60_000,
        recordCleanupIntervalMs: false,
      },
    });

    const start = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest({ cwd: '/repo/missing-detached' }),
        delivery: 'detached',
      }),
    });
    expect(start.status).toBe(202);

    worker.runs.clear();
    const status = await app.request('/v1/review/review-missing-detached');

    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      reviewId: 'review-missing-detached',
      status: 'failed',
      error: 'detached run not found',
    });
    const failedRecord = await store.get('review-missing-detached');
    expect(failedRecord).toMatchObject({
      status: 'failed',
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'failed' }),
      ]),
    });
    expect(failedRecord?.lease).toBeUndefined();
    expect(worker.cancelledRunIds).toEqual([]);
  });

  it('marks active runs failed when their runtime lease expires', async () => {
    const store = createStore();
    await store.set(
      createReviewRecord({
        reviewId: 'review-expired-lease',
        status: 'running',
        lease: {
          owner: 'test',
          scopeKey: 'localTrusted|codexDelegate|scope|custom',
          acquiredAt: 1_000,
          heartbeatAt: 1_000,
          expiresAt: 1_500,
        },
      })
    );
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker: createWorker(),
      store,
      nowMs: () => 2_000,
      uuid: createUuid(['event-expired']),
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/review-expired-lease');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      reviewId: 'review-expired-lease',
      status: 'failed',
      error: 'runtime lease expired',
    });
    const failedRecord = await store.get('review-expired-lease');
    expect(failedRecord).toMatchObject({
      status: 'failed',
      events: [expect.objectContaining({ type: 'failed' })],
    });
    expect(failedRecord?.lease).toBeUndefined();
  });

  it('syncs terminal worker state before returning cancel conflicts', async () => {
    const worker = createWorker();
    const request = createRequest();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      nowMs: () => 4_500,
      uuid: createUuid([
        'review-terminal-cancel',
        'event-start',
        'event-exited',
        'event-artifact-json',
        'event-artifact-markdown',
      ]),
      config: { recordCleanupIntervalMs: false },
    });

    const start = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request,
        delivery: 'detached',
      }),
    });
    expect(start.status).toBe(202);

    const run = worker.runs.get('detached-run-1');
    expect(run).toBeDefined();
    if (!run) {
      throw new Error('detached run was not started');
    }
    run.status = 'completed';
    run.completedAt = 4_500;
    run.result = createReviewResult(request);

    const cancel = await app.request(
      '/v1/review/review-terminal-cancel/cancel',
      {
        method: 'POST',
      }
    );

    expect(cancel.status).toBe(409);
    expect(await cancel.json()).toEqual({
      reviewId: 'review-terminal-cancel',
      status: 'completed',
      cancelled: false,
    });
  });

  it('applies injected auth policy before route work begins', async () => {
    const worker = createWorker();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      authStore: createInMemoryReviewAuthStore(),
      authPolicy: () =>
        Response.json({ error: 'unauthorized' }, { status: 401 }),
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest(),
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect(worker.started).toEqual([]);
  });

  it('requires an auth store when hosted auth policy is enabled', () => {
    expect(() =>
      createTestReviewServiceApp({
        providers: createProviders(),
        worker: createWorker(),
        authPolicy: () => null,
        config: { recordCleanupIntervalMs: false },
      })
    ).toThrow(/authStore is required/);
  });

  it('requires bearer auth when service token policy is enabled', async () => {
    const worker = createWorker();
    const { authPolicy, authStore } = await createServiceTokenAuth();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      authPolicy,
      authStore,
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createHostedRequest(),
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'authentication required' });
    expect(worker.started).toEqual([]);
    await expect(authStore.listAuthAuditEvents()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'authn',
          result: 'denied',
          reason: 'missing_bearer_token',
          status: 401,
        }),
      ])
    );
  });

  it('rejects revoked scoped service tokens before route work begins', async () => {
    const authStore = createInMemoryReviewAuthStore();
    const credential = createServiceTokenCredential({
      name: 'Revoked CI',
      scopes: ['review:start', 'review:read'],
      repository: createAuthorization().repository,
      pepper: 'test-pepper',
      nowMs: 1_000,
    });
    await authStore.setServiceToken({
      ...credential.record,
      revokedAt: 1_100,
    });
    const worker = createWorker();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      authStore,
      authPolicy: createReviewServiceAuthPolicy({
        store: authStore,
        serviceTokenPepper: 'test-pepper',
      }),
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        request: createHostedRequest(),
        repository: { owner: 'octo-org', name: 'agent-review' },
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(401);
    expect(worker.started).toEqual([]);
    await expect(authStore.listAuthAuditEvents()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'authn',
          result: 'denied',
          reason: 'service_token_revoked',
          status: 401,
        }),
      ])
    );
  });

  it('stops open SSE streams after scoped service tokens are revoked', async () => {
    const authStore = createInMemoryReviewAuthStore();
    const authorization = createAuthorization({
      principal: {
        type: 'serviceToken',
        tokenId: 'stream-token',
        tokenPrefix: 'rat_stream-token',
        name: 'CI',
      },
      actor: 'service-token:stream-token',
    });
    const streamCredential = createServiceTokenCredential({
      name: 'Stream CI',
      scopes: authorization.scopes,
      repository: authorization.repository,
      pepper: 'test-pepper',
      tokenId: 'stream-token',
      nowMs: 1_000,
    });
    const triggerCredential = createServiceTokenCredential({
      name: 'Trigger CI',
      scopes: authorization.scopes,
      repository: authorization.repository,
      pepper: 'test-pepper',
      tokenId: 'trigger-token',
      nowMs: 1_000,
    });
    await authStore.setServiceToken(streamCredential.record);
    await authStore.setServiceToken(triggerCredential.record);
    const store = createStore();
    const worker = createWorker();
    worker.runs.set(
      'detached-run-1',
      createDetachedRun({ runId: 'detached-run-1' })
    );
    store.records.set(
      'review-stream-auth',
      createReviewRecord({
        reviewId: 'review-stream-auth',
        status: 'running',
        authorization,
        detachedRunId: 'detached-run-1',
      })
    );
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      authPolicy: createReviewServiceAuthPolicy({
        store: authStore,
        serviceTokenPepper: 'test-pepper',
      }),
      authStore,
      config: {
        recordCleanupIntervalMs: false,
      },
    });

    const response = await app.request('/v1/review/review-stream-auth/events', {
      headers: { authorization: `Bearer ${streamCredential.token}` },
    });
    const session = createSseReaderSession(response);

    try {
      const tokenRecord = await authStore.getServiceToken('stream-token');
      expect(tokenRecord).toBeDefined();
      if (!tokenRecord) {
        throw new Error('stream token missing from auth store');
      }
      await authStore.setServiceToken({
        ...tokenRecord,
        revokedAt: 2_000,
        updatedAt: 2_000,
      });
      const run = worker.runs.get('detached-run-1');
      expect(run).toBeDefined();
      if (!run) {
        throw new Error('detached run missing from worker');
      }
      run.status = 'failed';
      run.error = 'post-revocation failure';
      run.completedAt = 2_100;

      const trigger = await app.request('/v1/review/review-stream-auth', {
        headers: { authorization: `Bearer ${triggerCredential.token}` },
      });
      expect(trigger.status).toBe(200);
      expect(await trigger.json()).toMatchObject({
        reviewId: 'review-stream-auth',
        status: 'failed',
      });

      await expect(readSseEventsUntilClose(session)).resolves.toEqual([]);
      await expect(authStore.listAuthAuditEvents()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: 'authz',
            result: 'denied',
            reason: 'service_token_revoked',
            status: 401,
            tokenId: 'stream-token',
          }),
        ])
      );
    } finally {
      await session.reader.cancel().catch(() => undefined);
    }
  });

  it('stops open SSE streams after scoped service token secrets are rotated', async () => {
    const authStore = createInMemoryReviewAuthStore();
    const authorization = createAuthorization({
      principal: {
        type: 'serviceToken',
        tokenId: 'stream-token',
        tokenPrefix: 'rat_stream-token',
        name: 'CI',
      },
      actor: 'service-token:stream-token',
    });
    const streamCredential = createServiceTokenCredential({
      name: 'Stream CI',
      scopes: authorization.scopes,
      repository: authorization.repository,
      pepper: 'test-pepper',
      tokenId: 'stream-token',
      secret: 'old_stream_secret_abcdefghijklmnopqrstuvwxyz',
      nowMs: 1_000,
    });
    const rotatedCredential = createServiceTokenCredential({
      name: 'Stream CI',
      scopes: authorization.scopes,
      repository: authorization.repository,
      pepper: 'test-pepper',
      tokenId: 'stream-token',
      secret: 'new_stream_secret_abcdefghijklmnopqrstuvwxyz',
      nowMs: 2_000,
    });
    const triggerCredential = createServiceTokenCredential({
      name: 'Trigger CI',
      scopes: authorization.scopes,
      repository: authorization.repository,
      pepper: 'test-pepper',
      tokenId: 'trigger-token',
      nowMs: 1_000,
    });
    await authStore.setServiceToken(streamCredential.record);
    await authStore.setServiceToken(triggerCredential.record);
    const store = createStore();
    const worker = createWorker();
    worker.runs.set(
      'detached-run-1',
      createDetachedRun({ runId: 'detached-run-1' })
    );
    store.records.set(
      'review-stream-rotated',
      createReviewRecord({
        reviewId: 'review-stream-rotated',
        status: 'running',
        authorization,
        detachedRunId: 'detached-run-1',
      })
    );
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      authPolicy: createReviewServiceAuthPolicy({
        store: authStore,
        serviceTokenPepper: 'test-pepper',
      }),
      authStore,
      config: {
        eventStreamPollIntervalMs: 50,
        recordCleanupIntervalMs: false,
      },
    });

    const response = await app.request(
      '/v1/review/review-stream-rotated/events',
      {
        headers: { authorization: `Bearer ${streamCredential.token}` },
      }
    );
    const session = createSseReaderSession(response);

    try {
      await authStore.setServiceToken(rotatedCredential.record);
      const run = worker.runs.get('detached-run-1');
      expect(run).toBeDefined();
      if (!run) {
        throw new Error('detached run missing from worker');
      }
      run.status = 'failed';
      run.error = 'post-rotation failure';
      run.completedAt = 2_100;

      const trigger = await app.request('/v1/review/review-stream-rotated', {
        headers: { authorization: `Bearer ${triggerCredential.token}` },
      });
      expect(trigger.status).toBe(200);
      expect(await trigger.json()).toMatchObject({
        reviewId: 'review-stream-rotated',
        status: 'failed',
      });

      await expect(readSseEventsUntilClose(session)).resolves.toEqual([]);
      await expect(authStore.listAuthAuditEvents()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: 'authz',
            result: 'denied',
            reason: 'service_token_invalid',
            status: 401,
            tokenId: 'stream-token',
          }),
        ])
      );
    } finally {
      await session.reader.cancel().catch(() => undefined);
    }
  });

  it('streams live SSE events while scoped service tokens remain authorized', async () => {
    const authorization = createAuthorization();
    const { authPolicy, authStore, token } = await createServiceTokenAuth({
      authorization,
    });
    const store = createStore();
    const worker = createWorker();
    worker.runs.set(
      'detached-run-1',
      createDetachedRun({ runId: 'detached-run-1' })
    );
    store.records.set(
      'review-stream-authorized',
      createReviewRecord({
        reviewId: 'review-stream-authorized',
        status: 'running',
        authorization,
        detachedRunId: 'detached-run-1',
      })
    );
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      authPolicy,
      authStore,
      config: {
        eventStreamPollIntervalMs: 1_000,
        recordCleanupIntervalMs: false,
      },
    });

    const response = await app.request(
      '/v1/review/review-stream-authorized/events',
      {
        headers: { authorization: `Bearer ${token}` },
      }
    );
    const session = createSseReaderSession(response);

    try {
      const run = worker.runs.get('detached-run-1');
      expect(run).toBeDefined();
      if (!run) {
        throw new Error('detached run missing from worker');
      }
      run.status = 'failed';
      run.error = 'authorized failure';
      run.completedAt = 2_100;

      const trigger = await app.request('/v1/review/review-stream-authorized', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(trigger.status).toBe(200);
      await expect(readNextSseEvent(session)).resolves.toMatchObject({
        event: 'failed',
        data: {
          type: 'failed',
          message: 'authorized failure',
        },
      });
    } finally {
      await session.reader.cancel().catch(() => undefined);
    }
  });

  it('stops GitHub user SSE streams when repository access is revoked', async () => {
    const worker = createWorker();
    const store = createStore();
    const authStore = createInMemoryReviewAuthStore();
    const repository = createAuthorization().repository;
    let now = 1_000;
    const githubPrincipal = {
      type: 'githubUser' as const,
      githubUserId: 101,
      login: 'octocat',
    };
    const triggerCredential = createServiceTokenCredential({
      name: 'Trigger CI',
      scopes: ['review:read'],
      repository,
      pepper: 'test-pepper',
      tokenId: 'github-trigger-token',
      nowMs: 1_000,
    });
    await authStore.setServiceToken(triggerCredential.record);
    let allowRepository = true;
    const authorizeUserToken = vi.fn(
      async (
        _token: string,
        _selection: ReviewRepositorySelection,
        scope: ReviewAuthScope
      ) => {
        if (!allowRepository) {
          throw Object.assign(new Error('repository access revoked'), {
            status: 404,
          });
        }
        const scopes: ReviewAuthScope[] =
          scope === 'review:read'
            ? ['review:read']
            : ['review:start', 'review:read'];
        return {
          principal: githubPrincipal,
          repository,
          scopes,
        };
      }
    );
    worker.runs.set(
      'detached-run-1',
      createDetachedRun({ runId: 'detached-run-1' })
    );
    store.records.set(
      'review-github-stream',
      createReviewRecord({
        reviewId: 'review-github-stream',
        status: 'running',
        authorization: createAuthorization({
          principal: githubPrincipal,
          actor: 'github:octocat',
          scopes: ['review:start', 'review:read'],
        }),
        detachedRunId: 'detached-run-1',
      })
    );
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      authStore,
      authPolicy: createReviewServiceAuthPolicy({
        store: authStore,
        serviceTokenPepper: 'test-pepper',
        githubUserTokenAuthorizer: {
          authenticateUserToken: vi.fn(async () => githubPrincipal),
          authorizeUserToken,
        },
      }),
      nowMs: () => now,
      config: {
        eventStreamPollIntervalMs: 50,
        githubStreamAuthorizationTtlMs: 25,
        recordCleanupIntervalMs: false,
      },
    });

    const response = await app.request(
      '/v1/review/review-github-stream/events',
      {
        headers: { authorization: 'Bearer github-user-token' },
      }
    );
    const session = createSseReaderSession(response);

    try {
      allowRepository = false;
      now = 1_100;
      const run = worker.runs.get('detached-run-1');
      expect(run).toBeDefined();
      if (!run) {
        throw new Error('detached run missing from worker');
      }
      run.status = 'failed';
      run.error = 'post-revocation GitHub failure';
      run.completedAt = 2_100;

      const trigger = await app.request('/v1/review/review-github-stream', {
        headers: { authorization: `Bearer ${triggerCredential.token}` },
      });
      expect(trigger.status).toBe(200);
      expect(await trigger.json()).toMatchObject({
        reviewId: 'review-github-stream',
        status: 'failed',
      });

      await expect(readSseEventsUntilClose(session)).resolves.toEqual([]);
      expect(authorizeUserToken.mock.calls.map((call) => call[2])).toContain(
        'review:read'
      );
      await expect(authStore.listAuthAuditEvents()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: 'authz',
            result: 'denied',
            reason: 'github_repository_not_accessible',
            status: 404,
            reviewId: 'review-github-stream',
          }),
        ])
      );
    } finally {
      await session.reader.cancel().catch(() => undefined);
    }
  });

  it('throttles GitHub SSE dynamic authorization within the stream TTL', async () => {
    const worker = createWorker();
    const store = createStore();
    const authStore = createInMemoryReviewAuthStore();
    const repository = createAuthorization().repository;
    let now = 1_000;
    const githubPrincipal = {
      type: 'githubUser' as const,
      githubUserId: 101,
      login: 'octocat',
    };
    const authorizeUserToken = vi.fn(
      async (
        _token: string,
        _selection: ReviewRepositorySelection,
        _scope: ReviewAuthScope
      ) => ({
        principal: githubPrincipal,
        repository,
        scopes: ['review:start', 'review:read'] as ReviewAuthScope[],
      })
    );
    worker.runs.set(
      'detached-run-1',
      createDetachedRun({ runId: 'detached-run-1' })
    );
    store.records.set(
      'review-github-stream-throttle',
      createReviewRecord({
        reviewId: 'review-github-stream-throttle',
        status: 'running',
        authorization: createAuthorization({
          principal: githubPrincipal,
          actor: 'github:octocat',
          scopes: ['review:start', 'review:read'],
        }),
        detachedRunId: 'detached-run-1',
      })
    );
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      authStore,
      authPolicy: createReviewServiceAuthPolicy({
        store: authStore,
        serviceTokenPepper: 'test-pepper',
        githubUserTokenAuthorizer: {
          authenticateUserToken: vi.fn(async () => githubPrincipal),
          authorizeUserToken,
        },
      }),
      nowMs: () => now,
      config: {
        eventStreamPollIntervalMs: 10,
        githubStreamAuthorizationTtlMs: 100,
        recordCleanupIntervalMs: false,
      },
    });

    const response = await app.request(
      '/v1/review/review-github-stream-throttle/events',
      {
        headers: { authorization: 'Bearer github-user-token' },
      }
    );
    const session = createSseReaderSession(response);

    try {
      expect(authorizeUserToken).toHaveBeenCalledTimes(1);
      await expect(readNextSseEvent(session)).resolves.toMatchObject({
        event: 'keepalive',
      });
      expect(authorizeUserToken).toHaveBeenCalledTimes(1);

      now = 1_150;
      await expect(readNextSseEvent(session)).resolves.toMatchObject({
        event: 'keepalive',
      });
      expect(authorizeUserToken).toHaveBeenCalledTimes(2);
    } finally {
      await session.reader.cancel().catch(() => undefined);
    }
  });

  it('accepts service token secrets that contain URL-safe separators', async () => {
    const worker = createWorker();
    const { authPolicy, authStore, token } = await createServiceTokenAuth({
      tokenId: 'token-id',
      secret: 'secret_with_underscore_abcdefghijklmnopqrstuvwxyz',
    });
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      authPolicy,
      authStore,
      nowMs: () => 1_000,
      uuid: createUuid([
        'audit-token-separator-start',
        'review-token-separator',
        'event-start',
      ]),
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        request: createHostedRequest(),
        repository: { owner: 'octo-org', name: 'agent-review' },
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(202);
    expect(worker.started).toHaveLength(1);
  });

  it('rejects service token ids that the redaction policy cannot match', () => {
    expect(() =>
      createServiceTokenCredential({
        name: 'CI',
        scopes: ['review:start'],
        repository: createAuthorization().repository,
        pepper: 'test-pepper',
        tokenId: 'a',
        secret: 'abcdefghijklmnopqrstuvwxyz',
      })
    ).toThrow(/at least 6/);
  });

  it('binds authenticated starts to durable repository authorization', async () => {
    const worker = createWorker();
    const store = createStore();
    const { authPolicy, authStore, token } = await createServiceTokenAuth();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      authPolicy,
      authStore,
      nowMs: () => 1_000,
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        request: createHostedRequest(),
        repository: { owner: 'octo-org', name: 'agent-review' },
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as { reviewId: string };
    await expect(store.get(body.reviewId)).resolves.toMatchObject({
      authorization: {
        principal: {
          type: 'serviceToken',
        },
        repository: {
          repositoryId: 42,
          installationId: 7,
          fullName: 'octo-org/agent-review',
        },
        scopes: ['review:start', 'review:read', 'review:cancel'],
      },
    });

    const status = await app.request(`/v1/review/${body.reviewId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status.status).toBe(200);
    await expect(authStore.listAuthAuditEvents()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'authz',
          operation: 'review:start',
          result: 'allowed',
        }),
        expect.objectContaining({
          eventType: 'authz',
          operation: 'review:read',
          result: 'allowed',
        }),
      ])
    );
  });

  it('revalidates GitHub user tokens against stored run repositories', async () => {
    const worker = createWorker();
    const store = createStore();
    const authStore = createInMemoryReviewAuthStore();
    const repository = createAuthorization().repository;
    const githubPrincipal = {
      type: 'githubUser' as const,
      githubUserId: 101,
      login: 'octocat',
    };
    const authenticateUserToken = vi.fn(async () => githubPrincipal);
    const authorizeUserToken = vi.fn(
      async (
        _token: string,
        selection: ReviewRepositorySelection,
        scope: ReviewAuthScope
      ) => {
        const scopes: ReviewAuthScope[] =
          scope === 'review:read'
            ? ['review:read']
            : ['review:start', 'review:read'];
        return {
          principal: githubPrincipal,
          repository: {
            ...repository,
            ...(selection.pullRequestNumber
              ? { pullRequestNumber: selection.pullRequestNumber }
              : {}),
          },
          scopes,
        };
      }
    );
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      authStore,
      authPolicy: createReviewServiceAuthPolicy({
        store: authStore,
        serviceTokenPepper: 'test-pepper',
        githubUserTokenAuthorizer: {
          authenticateUserToken,
          authorizeUserToken,
        },
      }),
      nowMs: () => 1_000,
      uuid: createUuid([
        'audit-github-user-start',
        'review-github-user-token',
        'event-start',
        'audit-github-user-read',
        'audit-github-user-cancel',
      ]),
      config: { recordCleanupIntervalMs: false },
    });

    const start = await app.request('/v1/review/start', {
      method: 'POST',
      headers: {
        authorization: 'Bearer github-user-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        request: createHostedRequest(),
        repository: {
          owner: 'octo-org',
          name: 'agent-review',
          pullRequestNumber: 24,
        },
        delivery: 'detached',
      }),
    });
    expect(start.status).toBe(202);
    const body = (await start.json()) as { reviewId: string };

    const status = await app.request(`/v1/review/${body.reviewId}`, {
      headers: { authorization: 'Bearer github-user-token' },
    });

    expect(status.status).toBe(200);
    expect(authorizeUserToken.mock.calls.map((call) => call[2])).toEqual([
      'review:start',
      'review:read',
    ]);
    expect(authenticateUserToken).toHaveBeenCalledTimes(2);
    await expect(store.get(body.reviewId)).resolves.toMatchObject({
      authorization: {
        principal: {
          type: 'githubUser',
          githubUserId: 101,
          login: 'octocat',
        },
        repository: {
          pullRequestNumber: 24,
        },
        scopes: ['review:start', 'review:read'],
      },
    });
    const stored = await store.get(body.reviewId);
    expect(stored?.authorization?.scopes).not.toContain('review:publish');
    expect(stored?.authorization?.scopes).not.toContain('review:cancel');

    const cancel = await app.request(`/v1/review/${body.reviewId}/cancel`, {
      method: 'POST',
      headers: { authorization: 'Bearer github-user-token' },
    });
    expect(cancel.status).toBe(403);
    expect(authorizeUserToken.mock.calls.map((call) => call[2])).toEqual([
      'review:start',
      'review:read',
      'review:cancel',
    ]);
    expect(authenticateUserToken).toHaveBeenCalledTimes(3);
    expect(worker.cancelledRunIds).toEqual([]);
  });

  it('maps invalid GitHub bearer tokens to authentication failures', async () => {
    const authStore = createInMemoryReviewAuthStore();
    const invalidToken = Object.assign(new Error('Bad credentials'), {
      status: 401,
    });
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker: createWorker(),
      authStore,
      authPolicy: createReviewServiceAuthPolicy({
        store: authStore,
        serviceTokenPepper: 'test-pepper',
        githubUserTokenAuthorizer: {
          authenticateUserToken: vi.fn(async () => {
            throw invalidToken;
          }),
          authorizeUserToken: vi.fn(async () => {
            throw new Error('should not authorize repository');
          }),
        },
      }),
      uuid: createUuid(['audit-invalid-github-token']),
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: {
        authorization: 'Bearer github-user-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        request: createHostedRequest(),
        repository: { owner: 'octo-org', name: 'agent-review' },
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid bearer token' });
    await expect(authStore.listAuthAuditEvents()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'request',
          result: 'denied',
          reason: 'github_token_invalid',
          status: 401,
        }),
      ])
    );
  });

  it('rejects malformed service-token prefixes before GitHub authentication', async () => {
    const authStore = createInMemoryReviewAuthStore();
    const authenticateUserToken = vi.fn(async () => ({
      type: 'githubUser' as const,
      githubUserId: 101,
      login: 'octocat',
    }));
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker: createWorker(),
      authStore,
      authPolicy: createReviewServiceAuthPolicy({
        store: authStore,
        serviceTokenPepper: 'test-pepper',
        githubUserTokenAuthorizer: {
          authenticateUserToken,
          authorizeUserToken: vi.fn(async () => {
            throw new Error('should not authorize repository');
          }),
        },
      }),
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: {
        authorization: 'Bearer rat_malformed',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        request: createHostedRequest(),
        repository: { owner: 'octo-org', name: 'agent-review' },
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid bearer token' });
    expect(authenticateUserToken).not.toHaveBeenCalled();
    await expect(authStore.listAuthAuditEvents()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'request',
          result: 'denied',
          reason: 'service_token_invalid',
          status: 401,
        }),
      ])
    );
  });

  it('maps GitHub authentication outages to dependency failures', async () => {
    const authStore = createInMemoryReviewAuthStore();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker: createWorker(),
      authStore,
      authPolicy: createReviewServiceAuthPolicy({
        store: authStore,
        serviceTokenPepper: 'test-pepper',
        githubUserTokenAuthorizer: {
          authenticateUserToken: vi.fn(async () => {
            throw new Error('github unavailable');
          }),
          authorizeUserToken: vi.fn(async () => {
            throw new Error('should not authorize repository');
          }),
        },
      }),
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: {
        authorization: 'Bearer github-user-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        request: createHostedRequest(),
        repository: { owner: 'octo-org', name: 'agent-review' },
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'authentication unavailable',
    });
    await expect(authStore.listAuthAuditEvents()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'authn',
          operation: 'request',
          result: 'denied',
          reason: 'github_auth_unavailable',
          status: 502,
        }),
      ])
    );
  });

  it('preserves authentication failures on existing GitHub run routes', async () => {
    const authStore = createInMemoryReviewAuthStore();
    const invalidToken = Object.assign(new Error('Bad credentials'), {
      status: 401,
    });
    const store = createStore();
    store.records.set(
      'review-github-invalid-token',
      createReviewRecord({
        reviewId: 'review-github-invalid-token',
        authorization: createAuthorization({
          principal: {
            type: 'githubUser',
            githubUserId: 101,
            login: 'octocat',
          },
          actor: 'github:octocat',
          scopes: ['review:start', 'review:read'],
        }),
        status: 'running',
      })
    );
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker: createWorker(),
      store,
      authStore,
      authPolicy: createReviewServiceAuthPolicy({
        store: authStore,
        serviceTokenPepper: 'test-pepper',
        githubUserTokenAuthorizer: {
          authenticateUserToken: vi.fn(async () => {
            throw invalidToken;
          }),
          authorizeUserToken: vi.fn(async () => {
            throw new Error('should not authorize repository');
          }),
        },
      }),
      uuid: createUuid(['audit-invalid-github-read']),
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request(
      '/v1/review/review-github-invalid-token',
      {
        headers: { authorization: 'Bearer github-user-token' },
      }
    );
    const missing = await app.request('/v1/review/review-missing', {
      headers: { authorization: 'Bearer github-user-token' },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid bearer token' });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'invalid bearer token' });
    await expect(authStore.listAuthAuditEvents()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'request',
          result: 'denied',
          reason: 'github_token_invalid',
          status: 401,
        }),
      ])
    );
  });

  it('reports service-token auth store failures as dependency failures', async () => {
    const authStore: ReviewAuthStoreAdapter = {
      async getServiceToken() {
        throw new Error('auth store unavailable');
      },
      async setServiceToken() {
        throw new Error('not used');
      },
      async touchServiceToken() {
        throw new Error('not used');
      },
      async upsertGitHubUser() {
        throw new Error('not used');
      },
      async upsertGitHubInstallation() {
        throw new Error('not used');
      },
      async upsertGitHubRepository() {
        throw new Error('not used');
      },
      async upsertGitHubRepositoryPermission() {
        throw new Error('not used');
      },
      async appendAuthAuditEvent() {
        return undefined;
      },
      async listAuthAuditEvents() {
        return [];
      },
    };
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker: createWorker(),
      authStore,
      authPolicy: createReviewServiceAuthPolicy({
        store: authStore,
        serviceTokenPepper: 'test-pepper',
      }),
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: {
        authorization: 'Bearer rat_token-id_abcdefghijklmnopqrstuvwxyz',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        request: createHostedRequest(),
        repository: { owner: 'octo-org', name: 'agent-review' },
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'authentication unavailable',
    });
  });

  it('reports auth audit store failures as dependency failures', async () => {
    const authStore: ReviewAuthStoreAdapter = {
      async getServiceToken() {
        throw new Error('not used');
      },
      async setServiceToken() {
        throw new Error('not used');
      },
      async touchServiceToken() {
        throw new Error('not used');
      },
      async upsertGitHubUser() {
        throw new Error('not used');
      },
      async upsertGitHubInstallation() {
        throw new Error('not used');
      },
      async upsertGitHubRepository() {
        throw new Error('not used');
      },
      async upsertGitHubRepositoryPermission() {
        throw new Error('not used');
      },
      async appendAuthAuditEvent() {
        throw new Error('audit store unavailable');
      },
      async listAuthAuditEvents() {
        return [];
      },
    };
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker: createWorker(),
      authStore,
      authPolicy: createReviewServiceAuthPolicy({
        store: authStore,
        serviceTokenPepper: 'test-pepper',
      }),
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createHostedRequest(),
        repository: { owner: 'octo-org', name: 'agent-review' },
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'authentication unavailable',
    });
  });

  it('blocks route work when authorization audit writes fail', async () => {
    const backingStore = createInMemoryReviewAuthStore();
    const credential = createServiceTokenCredential({
      name: 'CI',
      scopes: ['review:start', 'review:read'],
      repository: createAuthorization().repository,
      pepper: 'test-pepper',
      nowMs: 1_000,
    });
    await backingStore.setServiceToken(credential.record);
    let auditCalls = 0;
    const authStore: ReviewAuthStoreAdapter = {
      ...backingStore,
      async appendAuthAuditEvent(record) {
        auditCalls += 1;
        if (auditCalls > 1) {
          throw new Error('audit store unavailable');
        }
        await backingStore.appendAuthAuditEvent(record);
      },
    };
    const worker = createWorker();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      authStore,
      authPolicy: createReviewServiceAuthPolicy({
        store: authStore,
        serviceTokenPepper: 'test-pepper',
      }),
      logger: { error: vi.fn() },
      uuid: createUuid(['audit-authz-start']),
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        request: createHostedRequest(),
        repository: { owner: 'octo-org', name: 'agent-review' },
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'authorization unavailable',
    });
    expect(worker.started).toEqual([]);
  });

  it('rejects authenticated starts when cwd is outside the authorized checkout', async () => {
    const worker = createWorker();
    const { authPolicy, authStore, token } = await createServiceTokenAuth();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      authPolicy,
      authStore,
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        request: createRequest({ cwd: '/repo/other-org/other-private' }),
        repository: { owner: 'octo-org', name: 'agent-review' },
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'cwd must resolve under the authorized repository checkout root',
    });
    expect(worker.started).toEqual([]);
    await expect(authStore.listAuthAuditEvents()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'review:start',
          result: 'denied',
          reason: 'cwd_repository_mismatch',
          status: 403,
        }),
      ])
    );
  });

  it('rejects repository authorization records with path-like checkout segments', async () => {
    const worker = createWorker();
    const authStore = createInMemoryReviewAuthStore();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      authStore,
      authPolicy: () => ({
        principal: {
          type: 'serviceToken',
          tokenId: 'token-1',
          tokenPrefix: 'rat_token-1',
          name: 'CI',
        },
        repositories: [
          {
            ...createAuthorization().repository,
            name: '../agent-review',
            fullName: 'octo-org/../agent-review',
          },
        ],
        scopes: ['review:start', 'review:read'],
      }),
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: {
        authorization: 'Bearer injected-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        request: createRequest({ cwd: '/repo/agent-review' }),
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'repository name must be a single safe path segment',
    });
    expect(worker.started).toEqual([]);
    await expect(authStore.listAuthAuditEvents()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'review:start',
          result: 'denied',
          reason: 'cwd_repository_mismatch',
          status: 403,
        }),
      ])
    );
  });

  it('allows repository authorization records with safe consecutive dots', async () => {
    const worker = createWorker();
    const authStore = createInMemoryReviewAuthStore();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      authStore,
      authPolicy: () => ({
        principal: {
          type: 'serviceToken',
          tokenId: 'token-1',
          tokenPrefix: 'rat_token-1',
          name: 'CI',
        },
        repositories: [
          {
            ...createAuthorization().repository,
            name: 'agent..review',
            fullName: 'octo-org/agent..review',
          },
        ],
        scopes: ['review:start', 'review:read'],
      }),
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: {
        authorization: 'Bearer injected-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        request: createRequest({ cwd: '/repo/octo-org/agent..review' }),
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(202);
    expect(worker.started).toHaveLength(1);
  });

  it('conceals review IDs across repository authorization boundaries', async () => {
    const worker = createWorker();
    const store = createStore();
    const { authPolicy, authStore, token } = await createServiceTokenAuth({
      authorization: createAuthorization({
        repository: {
          ...createAuthorization().repository,
          repositoryId: 99,
          owner: 'other-org',
          name: 'other-repo',
          fullName: 'other-org/other-repo',
        },
      }),
    });
    store.records.set(
      'review-owned-by-other-repo',
      createReviewRecord({
        reviewId: 'review-owned-by-other-repo',
        authorization: createAuthorization(),
        result: createReviewResult(createRequest()),
        status: 'completed',
      })
    );
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      authPolicy,
      authStore,
      config: { recordCleanupIntervalMs: false },
    });

    const status = await app.request('/v1/review/review-owned-by-other-repo', {
      headers: { authorization: `Bearer ${token}` },
    });
    const artifact = await app.request(
      '/v1/review/review-owned-by-other-repo/artifacts/json',
      {
        headers: { authorization: `Bearer ${token}` },
      }
    );
    const cancel = await app.request(
      '/v1/review/review-owned-by-other-repo/cancel',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }
    );

    expect(status.status).toBe(404);
    expect(artifact.status).toBe(404);
    expect(cancel.status).toBe(404);
    expect(worker.cancelledRunIds).toEqual([]);
    await expect(authStore.listAuthAuditEvents()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'review:read',
          result: 'denied',
          status: 404,
        }),
        expect.objectContaining({
          operation: 'review:cancel',
          result: 'denied',
          status: 404,
        }),
      ])
    );
  });

  it('conceals cross-repository review IDs before reporting missing scopes', async () => {
    const worker = createWorker();
    const store = createStore();
    const { authPolicy, authStore, token } = await createServiceTokenAuth({
      scopes: ['review:cancel'],
      authorization: createAuthorization({
        repository: {
          ...createAuthorization().repository,
          repositoryId: 99,
          owner: 'other-org',
          name: 'other-repo',
          fullName: 'other-org/other-repo',
        },
      }),
    });
    store.records.set(
      'review-wrong-repo-no-read-scope',
      createReviewRecord({
        reviewId: 'review-wrong-repo-no-read-scope',
        authorization: createAuthorization(),
        result: createReviewResult(createRequest()),
        status: 'completed',
      })
    );
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      authPolicy,
      authStore,
      config: { recordCleanupIntervalMs: false },
    });

    const status = await app.request(
      '/v1/review/review-wrong-repo-no-read-scope',
      {
        headers: { authorization: `Bearer ${token}` },
      }
    );
    const missing = await app.request('/v1/review/review-does-not-exist', {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(status.status).toBe(404);
    expect(await status.json()).toEqual({ error: 'review not found' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'review not found' });
    await expect(authStore.listAuthAuditEvents()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'review:read',
          result: 'denied',
          reason: 'repository_not_granted',
          status: 404,
        }),
      ])
    );
  });

  it('returns 403 when token scope is missing for a known repository', async () => {
    const worker = createWorker();
    const store = createStore();
    const { authPolicy, authStore, token } = await createServiceTokenAuth({
      scopes: ['review:read'],
    });
    store.records.set(
      'review-no-cancel-scope',
      createReviewRecord({
        reviewId: 'review-no-cancel-scope',
        authorization: createAuthorization(),
        detachedRunId: 'detached-run-1',
        status: 'running',
      })
    );
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      authPolicy,
      authStore,
      config: { recordCleanupIntervalMs: false },
    });

    const cancel = await app.request(
      '/v1/review/review-no-cancel-scope/cancel',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }
    );

    expect(cancel.status).toBe(403);
    expect(await cancel.json()).toEqual({ error: 'authorization denied' });
    expect(worker.cancelledRunIds).toEqual([]);
  });

  it('returns canonical storage errors for start and read routes', async () => {
    const logger = { error: vi.fn() };
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker: createWorker(),
      store: createThrowingStore(),
      logger,
      config: { recordCleanupIntervalMs: false },
    });

    const start = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest(),
      }),
    });

    expect(start.status).toBe(502);
    expect(await start.json()).toEqual({ error: 'failed to start review' });

    const status = await app.request('/v1/review/review-storage');
    expect(status.status).toBe(502);
    expect(await status.json()).toEqual({
      error: 'failed to fetch run status',
    });

    const events = await app.request('/v1/review/review-storage/events');
    expect(events.status).toBe(502);
    expect(await events.json()).toEqual({
      error: 'failed to fetch event stream status',
    });

    const artifact = await app.request(
      '/v1/review/review-storage/artifacts/json'
    );
    expect(artifact.status).toBe(502);
    expect(await artifact.json()).toEqual({
      error: 'failed to fetch artifact status',
    });

    const cancel = await app.request('/v1/review/review-storage/cancel', {
      method: 'POST',
    });
    expect(cancel.status).toBe(502);
    expect(await cancel.json()).toEqual({ error: 'failed to cancel run' });
    expect(logger.error).toHaveBeenCalled();
  });

  it('requires detached delivery for remote sandbox requests', async () => {
    const worker = createWorker();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest({ executionMode: 'remoteSandbox' }),
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'executionMode "remoteSandbox" requires detached delivery',
    });
    expect(worker.started).toEqual([]);
  });

  it('accepts detached remote sandbox requests and persists sandbox ids', async () => {
    const request = createRequest({ executionMode: 'remoteSandbox' });
    const baseResult = createReviewResult(request);
    const result: ReviewRunResult = {
      ...baseResult,
      result: {
        ...baseResult.result,
        metadata: {
          ...baseResult.result.metadata,
          sandboxId: 'sbx-service-test',
        },
      },
      sandboxAudit: {
        sandboxId: 'sbx-service-test',
        policy: {
          networkProfile: 'deny_all',
          allowlistDomains: [],
          commandAllowlistSize: 1,
          envAllowlistSize: 1,
        },
        consumed: {
          commandCount: 1,
          wallTimeMs: 1,
          outputBytes: 1,
          artifactBytes: 1,
        },
        redactions: { apiKeyLike: 0, bearer: 0 },
        commands: [],
      },
    };
    const worker = createWorker(
      createDetachedRun({
        status: 'completed',
        completedAt: 1_500,
        result,
        sandboxId: 'sbx-service-test',
      })
    );
    const store = createStore();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request,
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      reviewId: string;
      status: string;
      detachedRunId: string;
    };
    expect(body).toMatchObject({
      status: 'completed',
      detachedRunId: 'detached-run-1',
    });
    expect(worker.started).toEqual([
      expect.objectContaining({
        ...request,
        maxFiles: 200,
        maxDiffBytes: 1048576,
      }),
    ]);
    expect(store.records.get(body.reviewId)?.sandboxId).toBe(
      'sbx-service-test'
    );

    const status = await app.request(`/v1/review/${body.reviewId}`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      result: {
        metadata: {
          sandboxId: 'sbx-service-test',
        },
      },
    });
  });

  it('rejects detached git-backed remote sandbox requests before dispatch', async () => {
    const worker = createWorker();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest({
          executionMode: 'remoteSandbox',
          target: { type: 'uncommittedChanges' },
        }),
        delivery: 'detached',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        'executionMode "remoteSandbox" currently supports only custom targets until sandbox source binding is implemented; received target "uncommittedChanges"',
    });
    expect(worker.started).toEqual([]);
  });

  it('returns a validation error for invalid start payloads', async () => {
    const worker = createWorker();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      config: { recordCleanupIntervalMs: false },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: {
          cwd: '',
          target: { type: 'custom', instructions: '' },
          provider: 'codexDelegate',
          executionMode: 'localTrusted',
          outputFormats: [],
        },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid review start request',
    });
    expect(worker.started).toEqual([]);
  });

  it('rejects oversized start bodies and cwd values outside allowed roots', async () => {
    const worker = createWorker();
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      config: {
        maxRequestBodyBytes: 128,
        recordCleanupIntervalMs: false,
      },
    });

    const oversized = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest({
          target: { type: 'custom', instructions: 'x'.repeat(256) },
        }),
      }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({
      error: 'review start request body exceeds configured byte limit',
    });

    const cwdEscapeApp = createTestReviewServiceApp({
      providers: createProviders(),
      worker,
      config: { recordCleanupIntervalMs: false },
    });
    const cwdEscape = await cwdEscapeApp.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest({ cwd: '/etc' }),
      }),
    });
    expect(cwdEscape.status).toBe(400);
    expect(await cwdEscape.json()).toEqual({
      error: 'cwd is outside configured review roots',
    });
    expect(worker.started).toEqual([]);
  });

  it('clamps explicit request budgets to configured service limits', async () => {
    const runner = vi.fn<ReviewServiceRunner>(async (request) =>
      createReviewResult(request)
    );
    const app = createTestReviewServiceApp({
      providers: createProviders(),
      worker: createWorker(),
      runner,
      uuid: createUuid(['review-budget-clamp', 'event-progress']),
      config: {
        recordCleanupIntervalMs: false,
        reviewLimits: {
          maxMaxFiles: 5,
          maxMaxDiffBytes: 1024,
          maxModelBytes: 4,
        },
      },
    });

    const response = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest({
          maxFiles: 100,
          maxDiffBytes: 65_536,
        }),
      }),
    });

    expect(response.status).toBe(200);
    expect(runner.mock.calls[0]?.[0]).toMatchObject({
      maxFiles: 5,
      maxDiffBytes: 1024,
    });

    const rejected = await app.request('/v1/review/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: createRequest({
          model: 'long-model-name',
        }),
      }),
    });

    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: 'model exceeds configured byte limit',
    });
  });
});
