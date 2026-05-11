import type { ReviewRunResult } from '@review-agent/review-core';
import { ReviewRunCancelledError } from '@review-agent/review-core';
import type {
  ReviewProvider,
  ReviewProviderKind,
  ReviewRequest,
  ReviewResult,
} from '@review-agent/review-types';
import type { DetachedRunRecord } from '@review-agent/review-worker';
import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryReviewStore,
  createReviewServiceApp,
  type ReviewRecord,
  type ReviewServiceRunner,
  type ReviewServiceWorker,
  type ReviewStoreAdapter,
} from './index.js';

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
    async reserve(record, options) {
      let queued = 0;
      let active = 0;
      let scopedActive = 0;
      for (const existing of records.values()) {
        if (
          ['completed', 'failed', 'cancelled'].includes(existing.status) ||
          existing.lease === undefined ||
          existing.lease.expiresAt <= options.nowMs
        ) {
          continue;
        }
        active += 1;
        if (existing.status === 'queued') {
          queued += 1;
        }
        if (existing.lease?.scopeKey === record.lease?.scopeKey) {
          scopedActive += 1;
        }
      }
      if (queued >= options.maxQueuedRuns) {
        return {
          reserved: false,
          reason: 'queue',
          message: 'review queue is at capacity',
        };
      }
      if (active >= options.maxRunningRuns) {
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

describe('createReviewServiceApp', () => {
  it('runs detached reviews through injected worker without sharing state', async () => {
    const providers = createProviders();
    const worker = createWorker();
    const app = createReviewServiceApp({
      providers,
      worker,
      nowMs: () => 1_000,
      uuid: createUuid(['review-1', 'event-1']),
      config: { recordCleanupIntervalMs: false },
    });
    const isolatedApp = createReviewServiceApp({
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
    const app = createReviewServiceApp({
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
    worker.startDetached = vi.fn(async () => {
      throw new Error('workflow start unavailable');
    });
    const app = createReviewServiceApp({
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
      error: 'workflow start unavailable',
      retentionExpiresAt: 3_601_500,
    });
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
    const app = createReviewServiceApp({
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

  it('syncs detached completion into status and artifact routes', async () => {
    const worker = createWorker();
    const store = createStore();
    const request = createRequest();
    const app = createReviewServiceApp({
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
    const bridge = {
      mirrorWrite: vi.fn(async () => true),
    };
    const runner = vi.fn<ReviewServiceRunner>(async (request) =>
      createReviewResult(request)
    );
    const app = createReviewServiceApp({
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
        request: createRequest(),
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
    expect(runner.mock.calls[0]?.[1].providers).toBe(providers);
    expect(runner.mock.calls[0]?.[2]).toBe(bridge);

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
      error: 'invalid artifact format xml',
    });
  });

  it('records inline cancellation as cancelled instead of failed', async () => {
    const runner = vi.fn<ReviewServiceRunner>(async () => {
      throw new ReviewRunCancelledError('user requested cancellation');
    });
    const app = createReviewServiceApp({
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
    const app = createReviewServiceApp({
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

  it('replays lifecycle events after the requested cursor', async () => {
    const runner = vi.fn<ReviewServiceRunner>(async () => {
      throw new Error('provider fixture failed');
    });
    const app = createReviewServiceApp({
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
    const app = createReviewServiceApp({
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
    const app = createReviewServiceApp({
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
    const app = createReviewServiceApp({
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
    const app = createReviewServiceApp({
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
    const app = createReviewServiceApp({
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
    const app = createReviewServiceApp({
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
    const app = createReviewServiceApp({
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
    const worker = createWorker();
    worker.startDetached = vi.fn(async (request) => {
      worker.started.push(request);
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
    const app = createReviewServiceApp({
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
    await Promise.resolve();
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
    const app = createReviewServiceApp({
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
    const app = createReviewServiceApp({
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
    const app = createReviewServiceApp({
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

  it('reconciles detached completion after lease TTL before expiring the lease', async () => {
    const request = createRequest();
    const worker = createWorker();
    const store = createStore();
    let currentTime = 1_000;
    const app = createReviewServiceApp({
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
    const app = createReviewServiceApp({
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
    const app = createReviewServiceApp({
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
    const app = createReviewServiceApp({
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
    const app = createReviewServiceApp({
      providers: createProviders(),
      worker,
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

  it('returns canonical storage errors for start and read routes', async () => {
    const logger = { error: vi.fn() };
    const app = createReviewServiceApp({
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
    const app = createReviewServiceApp({
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
    const app = createReviewServiceApp({
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
    expect(worker.started).toEqual([request]);
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
    const app = createReviewServiceApp({
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
    const app = createReviewServiceApp({
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
    const body = await response.json();
    expect(body).toEqual({
      error: expect.stringContaining('Too small'),
    });
    expect(worker.started).toEqual([]);
  });
});
