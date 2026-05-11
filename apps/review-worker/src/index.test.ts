import type { ReviewRunResult } from '@review-agent/review-core';
import type { ReviewProvider, ReviewRequest } from '@review-agent/review-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runReviewMock = vi.hoisted(() => vi.fn());
const workflowRuntimeMock = vi.hoisted(() => ({
  start: vi.fn(),
  getRun: vi.fn(),
}));

vi.mock('@review-agent/review-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@review-agent/review-core')>();
  return {
    ...actual,
    runReview: runReviewMock,
  };
});

vi.mock('@review-agent/review-provider-registry', () => ({
  createReviewProviders: () =>
    ({
      codexDelegate: {
        id: 'codexDelegate',
        capabilities: () => ({
          jsonSchemaOutput: true,
          reasoningControl: true,
          streaming: false,
        }),
        run: async () => ({
          raw: {
            findings: [],
            overall_correctness: 'patch is correct',
            overall_explanation: 'ok',
            overall_confidence_score: 1,
          },
          text: '',
          resolvedModel: 'codexDelegate:test',
        }),
      },
      openaiCompatible: {
        id: 'openaiCompatible',
        capabilities: () => ({
          jsonSchemaOutput: true,
          reasoningControl: true,
          streaming: false,
        }),
        run: async () => ({
          raw: {
            findings: [],
            overall_correctness: 'patch is correct',
            overall_explanation: 'ok',
            overall_confidence_score: 1,
          },
          text: '',
          resolvedModel: 'openaiCompatible:test',
        }),
      },
    }) satisfies Record<ReviewRequest['provider'], ReviewProvider>,
}));

vi.mock('@workflow/core/runtime', () => workflowRuntimeMock);

import { ReviewWorker } from './index.js';

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

function createReviewResult(request: ReviewRequest): ReviewRunResult {
  return {
    reviewId: 'core-review-1',
    request,
    result: {
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
    },
    artifacts: {
      json: '{"findings":[]}',
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

describe('ReviewWorker', () => {
  beforeEach(() => {
    runReviewMock.mockReset();
    workflowRuntimeMock.start.mockReset();
    workflowRuntimeMock.getRun.mockReset();
  });

  it('starts workflow-backed detached runs and syncs completed results', async () => {
    const request = createRequest();
    const result = createReviewResult(request);
    workflowRuntimeMock.start.mockResolvedValueOnce({
      runId: 'workflow-run-1',
    });
    workflowRuntimeMock.getRun.mockResolvedValueOnce({
      status: Promise.resolve('completed'),
      returnValue: Promise.resolve(result),
    });

    const worker = new ReviewWorker();
    const started = await worker.startDetached(request);

    expect(started).toMatchObject({
      runId: 'workflow-run-1',
      workflowRunId: 'workflow-run-1',
      status: 'running',
    });
    expect(workflowRuntimeMock.start).toHaveBeenCalledTimes(1);

    const synced = await worker.get('workflow-run-1');
    expect(synced).toMatchObject({
      runId: 'workflow-run-1',
      status: 'completed',
      result,
    });
  });

  it('captures workflow failures without throwing from status reads', async () => {
    workflowRuntimeMock.start.mockResolvedValueOnce({
      runId: 'workflow-run-failed',
    });
    workflowRuntimeMock.getRun.mockResolvedValueOnce({
      status: Promise.resolve('failed'),
      returnValue: Promise.reject(new Error('workflow exploded')),
    });

    const worker = new ReviewWorker();
    await worker.startDetached(createRequest());

    const failed = await worker.get('workflow-run-failed');
    expect(failed).toMatchObject({
      runId: 'workflow-run-failed',
      status: 'failed',
      error: 'workflow exploded',
    });
  });

  it('cancels workflow-backed runs through the workflow runtime', async () => {
    const request = createRequest();
    const result = createReviewResult(request);
    const cancel = vi.fn(async () => undefined);
    workflowRuntimeMock.start.mockResolvedValueOnce({
      runId: 'workflow-run-cancel',
    });
    workflowRuntimeMock.getRun
      .mockResolvedValueOnce({
        cancel,
      })
      .mockResolvedValueOnce({
        status: Promise.resolve('completed'),
        returnValue: Promise.resolve(result),
      });

    const worker = new ReviewWorker();
    await worker.startDetached(request);

    await expect(worker.cancel('workflow-run-cancel')).resolves.toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(workflowRuntimeMock.getRun).toHaveBeenCalledTimes(1);

    await expect(worker.get('workflow-run-cancel')).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(workflowRuntimeMock.getRun).toHaveBeenCalledTimes(1);

    await expect(worker.cancel('workflow-run-cancel')).resolves.toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(workflowRuntimeMock.getRun).toHaveBeenCalledTimes(1);
  });

  it('falls back to local cancellation when Workflow cancel fails', async () => {
    const cancel = vi.fn(async () => {
      throw new Error('workflow cancel failed');
    });
    workflowRuntimeMock.start.mockResolvedValueOnce({
      runId: 'workflow-run-cancel-failed',
    });
    workflowRuntimeMock.getRun.mockResolvedValueOnce({
      cancel,
    });

    const worker = new ReviewWorker();
    await worker.startDetached(createRequest());

    await expect(worker.cancel('workflow-run-cancel-failed')).resolves.toBe(
      true
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(
      worker.get('workflow-run-cancel-failed')
    ).resolves.toMatchObject({
      status: 'cancelled',
    });
  });

  it('falls back to local detached execution when Workflow start fails', async () => {
    const request = createRequest();
    const result = createReviewResult(request);
    workflowRuntimeMock.start.mockRejectedValueOnce(
      new Error('workflow unavailable')
    );
    runReviewMock.mockResolvedValueOnce(result);

    const worker = new ReviewWorker();
    const started = await worker.startDetached(request);

    expect(started.workflowRunId).toBeUndefined();
    await vi.waitFor(async () => {
      await expect(worker.get(started.runId)).resolves.toMatchObject({
        runId: started.runId,
        status: 'completed',
        result,
      });
    });
    expect(runReviewMock).toHaveBeenCalledTimes(1);
  });

  it('validates detached request payloads before starting work', async () => {
    const worker = new ReviewWorker();

    await expect(
      worker.startDetached({
        cwd: '',
        target: { type: 'custom', instructions: '' },
        provider: 'codexDelegate',
        executionMode: 'localTrusted',
        outputFormats: [],
      })
    ).rejects.toThrow();

    expect(workflowRuntimeMock.start).not.toHaveBeenCalled();
    expect(runReviewMock).not.toHaveBeenCalled();
  });
});
