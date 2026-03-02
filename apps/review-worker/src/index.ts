import { randomUUID } from 'node:crypto';
import { type ReviewRunResult, runReview } from '@review-agent/review-core';
import { createCodexDelegateProvider } from '@review-agent/review-provider-codex';
import { createOpenAICompatibleReviewProvider } from '@review-agent/review-provider-openai';
import {
  type ReviewRequest,
  ReviewRequestSchema,
} from '@review-agent/review-types';

export type DetachedStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type DetachedRunRecord = {
  runId: string;
  status: DetachedStatus;
  startedAt: number;
  completedAt?: number;
  error?: string;
  result?: ReviewRunResult;
  workflowRunId?: string;
};

const providers = {
  codexDelegate: createCodexDelegateProvider(),
  openaiCompatible: createOpenAICompatibleReviewProvider(),
};

const localRunStore = new Map<string, DetachedRunRecord>();

function withProviders(request: ReviewRequest): Promise<ReviewRunResult> {
  return runReview(request, { providers });
}

async function runLocallyDetached(
  request: ReviewRequest
): Promise<DetachedRunRecord> {
  const runId = randomUUID();
  const record: DetachedRunRecord = {
    runId,
    status: 'queued',
    startedAt: Date.now(),
  };
  localRunStore.set(runId, record);

  void (async () => {
    record.status = 'running';
    try {
      record.result = await withProviders(request);
      record.status = 'completed';
      record.completedAt = Date.now();
    } catch (error) {
      record.status = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      record.completedAt = Date.now();
    }
  })();

  return record;
}

export async function reviewWorkflow(
  request: ReviewRequest
): Promise<ReviewRunResult> {
  'use workflow';
  return executeReviewStep(request);
}

async function executeReviewStep(
  request: ReviewRequest
): Promise<ReviewRunResult> {
  'use step';
  return withProviders(request);
}

export class ReviewWorker {
  async startDetached(requestInput: unknown): Promise<DetachedRunRecord> {
    const request = ReviewRequestSchema.parse(requestInput);
    try {
      const { start } = await import('workflow/api');
      const run = await start(reviewWorkflow, [request]);
      const record: DetachedRunRecord = {
        runId: run.runId,
        workflowRunId: run.runId,
        status: 'running',
        startedAt: Date.now(),
      };
      localRunStore.set(record.runId, record);
      return record;
    } catch {
      return runLocallyDetached(request);
    }
  }

  async get(runId: string): Promise<DetachedRunRecord | null> {
    const local = localRunStore.get(runId);
    if (!local) {
      return null;
    }

    if (local.workflowRunId) {
      try {
        const { getRun } = await import('workflow/api');
        const workflowRun = await getRun(local.workflowRunId);
        const status = await workflowRun.status;
        if (status === 'completed') {
          local.status = 'completed';
          local.completedAt = Date.now();
          local.result = (await workflowRun.returnValue) as ReviewRunResult;
        } else if (status === 'failed') {
          local.status = 'failed';
          try {
            await workflowRun.returnValue;
            local.error = 'workflow failed';
          } catch (error) {
            local.error =
              error instanceof Error ? error.message : String(error);
          }
          local.completedAt = Date.now();
        } else if (status === 'cancelled') {
          local.status = 'cancelled';
          local.completedAt = Date.now();
        }
      } catch {
        // Keep local status.
      }
    }

    return local;
  }

  async cancel(runId: string): Promise<boolean> {
    const record = localRunStore.get(runId);
    if (!record) {
      return false;
    }

    if (record.workflowRunId) {
      try {
        const { getRun } = await import('workflow/api');
        const workflowRun = await getRun(record.workflowRunId);
        await workflowRun.cancel();
      } catch {
        // Fall through to local state update.
      }
    }

    if (record.status === 'completed' || record.status === 'failed') {
      return false;
    }
    record.status = 'cancelled';
    record.completedAt = Date.now();
    return true;
  }
}
