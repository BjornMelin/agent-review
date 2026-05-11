import type { ReviewRunResult } from '@review-agent/review-core';
import type { ReviewProvider, ReviewRequest } from '@review-agent/review-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runReviewMock = vi.hoisted(() => vi.fn());
const runInSandboxMock = vi.hoisted(() => vi.fn());
const getWorkflowMetadataMock = vi.hoisted(() => vi.fn());
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

vi.mock('@review-agent/review-sandbox-vercel', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@review-agent/review-sandbox-vercel')
    >();
  return {
    ...actual,
    runInSandbox: runInSandboxMock,
  };
});

vi.mock('@workflow/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workflow/core')>();
  return {
    ...actual,
    getWorkflowMetadata: getWorkflowMetadataMock,
  };
});

vi.mock('@workflow/core/runtime', () => workflowRuntimeMock);

import {
  REVIEW_WORKFLOW_STEP_MAX_RETRIES,
  ReviewWorker,
  reviewExecutionStep,
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
    runInSandboxMock.mockReset();
    getWorkflowMetadataMock.mockReset();
    getWorkflowMetadataMock.mockImplementation(() => {
      throw new Error('workflow metadata unavailable');
    });
    workflowRuntimeMock.start.mockReset();
    workflowRuntimeMock.getRun.mockReset();
  });

  it('starts workflow-backed detached runs without reading status immediately', async () => {
    const request = createRequest();
    const result = createReviewResult(request);
    const statusRead = vi.fn(() => {
      throw new Error('status should be read by later reconciliation');
    });
    workflowRuntimeMock.start.mockResolvedValueOnce({
      runId: 'workflow-run-1',
      get status() {
        return statusRead();
      },
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
      status: 'queued',
    });
    expect(statusRead).not.toHaveBeenCalled();
    expect(workflowRuntimeMock.start).toHaveBeenCalledTimes(1);

    const synced = await worker.get('workflow-run-1');
    expect(synced).toMatchObject({
      runId: 'workflow-run-1',
      status: 'completed',
      result,
    });
  });

  it('syncs workflow-backed results after a worker restart', async () => {
    const request = createRequest();
    const result = createReviewResult(request);
    workflowRuntimeMock.getRun.mockResolvedValueOnce({
      runId: 'workflow-run-restarted',
      status: Promise.resolve('completed'),
      returnValue: Promise.resolve(result),
    });

    const restartedWorker = new ReviewWorker();

    const synced = await restartedWorker.get('workflow-run-restarted');
    expect(synced).toMatchObject({
      runId: 'workflow-run-restarted',
      workflowRunId: 'workflow-run-restarted',
      status: 'completed',
      result,
    });
    expect(workflowRuntimeMock.getRun).toHaveBeenCalledWith(
      'workflow-run-restarted'
    );
  });

  it('maps pending workflow status to queued service status', async () => {
    workflowRuntimeMock.getRun.mockResolvedValueOnce({
      runId: 'workflow-run-pending',
      status: Promise.resolve('pending'),
    });

    const worker = new ReviewWorker();

    await expect(worker.get('workflow-run-pending')).resolves.toMatchObject({
      runId: 'workflow-run-pending',
      workflowRunId: 'workflow-run-pending',
      status: 'queued',
    });
  });

  it('treats missing workflow runs as unknown during reconciliation', async () => {
    workflowRuntimeMock.getRun.mockResolvedValueOnce({
      runId: 'workflow-run-missing',
      status: Promise.reject(
        Object.assign(
          new Error('Workflow run "workflow-run-missing" not found'),
          {
            name: 'WorkflowRunNotFoundError',
          }
        )
      ),
    });

    const worker = new ReviewWorker();

    await expect(worker.get('workflow-run-missing')).resolves.toBeNull();
  });

  it('captures workflow failures without throwing from status reads', async () => {
    workflowRuntimeMock.start.mockResolvedValueOnce({
      runId: 'workflow-run-failed',
      status: Promise.resolve('running'),
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
    const cancel = vi.fn(async () => undefined);
    workflowRuntimeMock.getRun
      .mockResolvedValueOnce({
        runId: 'workflow-run-cancel',
        status: Promise.resolve('running'),
        cancel,
      })
      .mockResolvedValue({
        runId: 'workflow-run-cancel',
        status: Promise.resolve('cancelled'),
        returnValue: Promise.resolve(undefined),
        cancel,
      });

    const worker = new ReviewWorker();

    await expect(worker.cancel('workflow-run-cancel')).resolves.toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(workflowRuntimeMock.getRun).toHaveBeenCalledTimes(1);

    await expect(worker.get('workflow-run-cancel')).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(workflowRuntimeMock.getRun).toHaveBeenCalledTimes(2);

    await expect(worker.cancel('workflow-run-cancel')).resolves.toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(workflowRuntimeMock.getRun).toHaveBeenCalledTimes(3);
  });

  it('propagates workflow cancellation failures instead of marking local success', async () => {
    const cancel = vi.fn(async () => {
      throw new Error('workflow cancel failed');
    });
    workflowRuntimeMock.getRun.mockResolvedValueOnce({
      runId: 'workflow-run-cancel-failed',
      status: Promise.resolve('running'),
      cancel,
    });

    const worker = new ReviewWorker();

    await expect(worker.cancel('workflow-run-cancel-failed')).rejects.toThrow(
      'workflow cancel failed'
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('aborts active in-process workflow steps during cancellation', async () => {
    const cancel = vi.fn(async () => undefined);
    let resolveRunReviewStarted: () => void = () => undefined;
    let resolveWorkflowStatus: (status: 'running') => void = () => undefined;
    const runReviewStarted = new Promise<void>((resolve) => {
      resolveRunReviewStarted = resolve;
    });
    const workflowStatus = new Promise<'running'>((resolve) => {
      resolveWorkflowStatus = resolve;
    });
    getWorkflowMetadataMock.mockReturnValue({
      workflowName: 'reviewWorkflow',
      workflowRunId: 'workflow-run-active',
      workflowStartedAt: new Date(),
      url: 'https://example.test/workflow',
    });
    runReviewMock.mockImplementationOnce(
      async (_request, options) =>
        new Promise((_resolve, reject) => {
          resolveRunReviewStarted();
          options.signal?.addEventListener('abort', () => {
            reject(options.signal?.reason);
          });
        })
    );
    workflowRuntimeMock.getRun.mockResolvedValueOnce({
      runId: 'workflow-run-active',
      status: workflowStatus,
      cancel,
    });

    const step = reviewExecutionStep(createRequest());
    await runReviewStarted;

    const worker = new ReviewWorker();
    const cancelling = worker.cancel('workflow-run-active');
    await expect(step).rejects.toThrow('detached review cancelled');
    expect(cancel).not.toHaveBeenCalled();
    resolveWorkflowStatus('running');
    await expect(cancelling).resolves.toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('returns false when cancelling an unknown workflow run', async () => {
    const cancel = vi.fn(async () => undefined);
    workflowRuntimeMock.getRun.mockResolvedValueOnce({
      runId: 'workflow-run-missing',
      status: Promise.reject(
        Object.assign(
          new Error('Workflow run "workflow-run-missing" not found'),
          {
            name: 'WorkflowRunNotFoundError',
          }
        )
      ),
      cancel,
    });

    const worker = new ReviewWorker();

    await expect(worker.cancel('workflow-run-missing')).resolves.toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('fails detached start when Workflow cannot accept the run', async () => {
    workflowRuntimeMock.start.mockRejectedValueOnce(
      new Error('workflow unavailable')
    );

    const worker = new ReviewWorker();

    await expect(worker.startDetached(createRequest())).rejects.toThrow(
      'workflow unavailable'
    );
    expect(runReviewMock).not.toHaveBeenCalled();
  });

  it('declares the review execution step retry budget', () => {
    const retryableStep = reviewExecutionStep as typeof reviewExecutionStep & {
      maxRetries: number;
    };
    expect(REVIEW_WORKFLOW_STEP_MAX_RETRIES).toBe(3);
    expect(retryableStep.maxRetries).toBe(REVIEW_WORKFLOW_STEP_MAX_RETRIES);
  });

  it('routes remote sandbox execution through a deny-all Vercel sandbox runner', async () => {
    const request = createRequest({ executionMode: 'remoteSandbox' });
    runInSandboxMock.mockResolvedValueOnce({
      sandboxId: 'sbx-worker-test',
      outputs: [
        {
          commandId: 'command-1',
          command: {
            cmd: 'node',
            args: ['review-runner.mjs'],
            cwd: '/vercel/sandbox',
            phase: 'runtime',
          },
          exitCode: 0,
          stdout: 'review-output.json\n',
          stderr: '',
        },
      ],
      artifacts: [
        {
          path: 'review-output.json',
          content: JSON.stringify({
            findings: [],
            overall_correctness: 'patch is correct',
            overall_explanation: 'sandbox ok',
            overall_confidence_score: 1,
          }),
          byteLength: 128,
        },
      ],
      audit: {
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
          artifactBytes: 128,
        },
        redactions: { apiKeyLike: 0, bearer: 0 },
        commands: [],
      },
    });
    runReviewMock.mockImplementationOnce(async (_request, options) => {
      const sandboxOutput = await options.sandboxRunner({
        request,
        resolvedPrompt: 'prompt',
        rubric: 'rubric',
        normalizedDiffChunks: [{ file: 'file.ts', patch: '+value' }],
      });
      return {
        ...createReviewResult(request),
        sandboxAudit: sandboxOutput.sandboxAudit,
      };
    });

    const result = await reviewExecutionStep(request);

    expect(result.sandboxAudit?.sandboxId).toBe('sbx-worker-test');
    expect(runInSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: [
          expect.objectContaining({
            cmd: 'node',
            args: ['review-runner.mjs'],
            cwd: '/vercel/sandbox',
            env: { CI: '1' },
          }),
        ],
        artifacts: [{ path: 'review-output.json' }],
        policy: expect.objectContaining({
          networkProfile: 'deny_all',
          allowlistDomains: [],
          commandAllowlist: new Set(['node']),
          envAllowlist: new Set(['CI']),
        }),
        runtime: 'node24',
      })
    );
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
