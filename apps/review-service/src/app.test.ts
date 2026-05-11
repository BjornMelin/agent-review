import type { ReviewRunResult } from '@review-agent/review-core';
import type {
  ReviewProvider,
  ReviewProviderKind,
  ReviewRequest,
  ReviewResult,
} from '@review-agent/review-types';
import type { DetachedRunRecord } from '@review-agent/review-worker';
import { describe, expect, it, vi } from 'vitest';
import {
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
    get(reviewId) {
      const record = records.get(reviewId);
      return record ? materialize(record) : undefined;
    },
    set(record) {
      const nextRecord = materialize(record);
      records.set(record.reviewId, nextRecord);
      writes.push(nextRecord);
    },
    delete(reviewId) {
      records.delete(reviewId);
      deletes.push(reviewId);
    },
    *entries() {
      for (const [reviewId, record] of records.entries()) {
        yield [reviewId, materialize(record)] as [string, ReviewRecord];
      }
    },
    size() {
      return records.size;
    },
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

  it('syncs detached completion into status and artifact routes', async () => {
    const worker = createWorker();
    const store = createStore();
    const request = createRequest();
    const app = createReviewServiceApp({
      providers: createProviders(),
      worker,
      store,
      nowMs: () => 1_000,
      uuid: createUuid(['review-detached', 'event-start']),
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
    expect(store.records.get('review-detached')?.status).toBe('completed');
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

  it('syncs terminal worker state before returning cancel conflicts', async () => {
    const worker = createWorker();
    const request = createRequest();
    const app = createReviewServiceApp({
      providers: createProviders(),
      worker,
      nowMs: () => 4_500,
      uuid: createUuid(['review-terminal-cancel', 'event-start']),
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

  it('rejects unsupported remote sandbox requests before dispatch', async () => {
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
      error: 'executionMode "remoteSandbox" is not supported by review-service',
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
