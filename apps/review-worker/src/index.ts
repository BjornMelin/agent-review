import { type ReviewRunResult, runReview } from '@review-agent/review-core';
import { createReviewProviders } from '@review-agent/review-provider-registry';
import {
  isTerminalReviewRunStatus,
  type ReviewRequest,
  ReviewRequestSchema,
  type ReviewRunStatus,
} from '@review-agent/review-types';

/**
 * Describes the observable state for a detached review run.
 *
 * @remarks
 * `runId` is the service-facing identifier. `workflowRunId` is present when
 * Vercel Workflow accepted the run.
 */
export type DetachedRunRecord = {
  runId: string;
  status: ReviewRunStatus;
  startedAt: number;
  completedAt?: number;
  error?: string;
  result?: ReviewRunResult;
  workflowRunId?: string;
};

const providers = createReviewProviders();

type WorkflowRuntimeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

type WorkflowRunHandle = {
  runId: string;
  status: WorkflowRuntimeStatus | Promise<WorkflowRuntimeStatus>;
  returnValue: Promise<unknown>;
  cancel(): void | Promise<void>;
};

/**
 * Defines the retry budget for the durable review execution step.
 */
export const REVIEW_WORKFLOW_STEP_MAX_RETRIES = 3;

function withProviders(request: ReviewRequest): Promise<ReviewRunResult> {
  return runReview(request, { providers });
}

function mapWorkflowStatus(status: WorkflowRuntimeStatus): ReviewRunStatus {
  return status === 'pending' ? 'queued' : status;
}

function isWorkflowRunNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.name === 'WorkflowRunNotFoundError';
}

async function hydrateWorkflowRecord(
  runId: string,
  workflowRun: WorkflowRunHandle
): Promise<DetachedRunRecord> {
  const status = mapWorkflowStatus(await Promise.resolve(workflowRun.status));
  const now = Date.now();
  const record: DetachedRunRecord = {
    runId,
    workflowRunId: runId,
    status,
    startedAt: now,
  };

  if (status === 'completed') {
    record.result = (await workflowRun.returnValue) as ReviewRunResult;
    record.completedAt = now;
  } else if (status === 'failed') {
    try {
      await workflowRun.returnValue;
      record.error = 'workflow failed';
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
    }
    record.completedAt = now;
  } else if (status === 'cancelled') {
    record.completedAt = now;
  }

  return record;
}

/**
 * Runs a validated review request inside the Workflow runtime.
 *
 * @param request - Review request payload parsed before Workflow starts.
 * @returns Completed review result emitted by the review core.
 */
export async function reviewWorkflow(
  request: ReviewRequest
): Promise<ReviewRunResult> {
  'use workflow';
  return reviewExecutionStep(request);
}

/**
 * Runs provider-backed review execution as an explicit retryable Workflow step.
 *
 * @param request - Validated review request supplied by the workflow function.
 * @returns Completed review result emitted by the review core.
 */
export async function reviewExecutionStep(
  request: ReviewRequest
): Promise<ReviewRunResult> {
  'use step';
  return withProviders(request);
}

Object.assign(reviewExecutionStep, {
  maxRetries: REVIEW_WORKFLOW_STEP_MAX_RETRIES,
});

/**
 * Coordinates detached review execution with Workflow runtime.
 */
export class ReviewWorker {
  /**
   * Starts a detached review run after validating the request payload.
   *
   * @param requestInput - Unknown request payload to parse with ReviewRequestSchema.
   * @returns Initial run record for workflow-backed execution.
   * @throws ZodError when the payload does not satisfy ReviewRequestSchema.
   * @throws Error when the Workflow runtime cannot accept the run.
   */
  async startDetached(requestInput: unknown): Promise<DetachedRunRecord> {
    const request = ReviewRequestSchema.parse(requestInput);
    const { start } = await import('@workflow/core/runtime');
    const run = (await start(reviewWorkflow, [request])) as WorkflowRunHandle;
    return {
      runId: run.runId,
      workflowRunId: run.runId,
      status: 'queued',
      startedAt: Date.now(),
    };
  }

  /**
   * Reads the current state of a detached run.
   *
   * @param runId - Detached run identifier returned by startDetached.
   * @returns Current run record, or null when the run is unknown.
   * @throws Error when Workflow status lookup fails.
   */
  async get(runId: string): Promise<DetachedRunRecord | null> {
    const { getRun } = await import('@workflow/core/runtime');
    const workflowRun = (await getRun(runId)) as
      | WorkflowRunHandle
      | null
      | undefined;
    if (!workflowRun) {
      return null;
    }
    try {
      return await hydrateWorkflowRecord(runId, workflowRun);
    } catch (error) {
      if (isWorkflowRunNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Attempts to cancel a queued or running detached review.
   *
   * @param runId - Detached run identifier returned by startDetached.
   * @returns True when cancellation was recorded, otherwise false.
   * @throws Error when Workflow status lookup or cancellation fails.
   */
  async cancel(runId: string): Promise<boolean> {
    const { getRun } = await import('@workflow/core/runtime');
    const workflowRun = (await getRun(runId)) as
      | WorkflowRunHandle
      | null
      | undefined;
    if (!workflowRun) {
      return false;
    }
    let current: DetachedRunRecord | null;
    try {
      current = await hydrateWorkflowRecord(runId, workflowRun);
    } catch (error) {
      if (isWorkflowRunNotFoundError(error)) {
        return false;
      }
      throw error;
    }
    if (!current || isTerminalReviewRunStatus(current.status)) {
      return false;
    }

    await workflowRun.cancel();
    return true;
  }
}
