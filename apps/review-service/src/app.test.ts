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
  type ReviewServiceRunner,
  type ReviewServiceWorker,
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

function createWorker(
  run: DetachedRunRecord = {
    runId: 'detached-run-1',
    status: 'running',
    startedAt: 1_000,
  }
): ReviewServiceWorker & { started: ReviewRequest[] } {
  const started: ReviewRequest[] = [];
  return {
    started,
    async startDetached(request) {
      started.push(request);
      return run;
    },
    async get() {
      return run;
    },
    async cancel() {
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

  it('runs inline reviews through the injected runner and serves artifacts', async () => {
    const providers = createProviders();
    const worker = createWorker();
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
});
