import {
  type ReviewRunResult,
  runReview,
  type SandboxReviewRunner,
} from '@review-agent/review-core';
import { createReviewProviders } from '@review-agent/review-provider-registry';
import {
  createDefaultPolicy,
  runInSandbox,
} from '@review-agent/review-sandbox-vercel';
import {
  isTerminalReviewRunStatus,
  type RawModelOutput,
  type ReviewRequest,
  ReviewRequestSchema,
  type ReviewRunStatus,
  type SandboxAudit,
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
  sandboxId?: string;
};

const providers = createReviewProviders();

const SANDBOX_ROOT = '/vercel/sandbox';

const SANDBOX_REVIEW_RUNNER = `
import { readFile, writeFile } from 'node:fs/promises';

const input = JSON.parse(await readFile(new URL('./review-input.json', import.meta.url), 'utf8'));
const diffBytes = input.normalizedDiffChunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.patch, 'utf8'), 0);
const raw = {
  findings: [],
  overall_correctness: 'patch is correct',
  overall_explanation: \`Remote sandbox policy runner completed under deny-all network for \${input.normalizedDiffChunks.length} diff chunk(s) and \${diffBytes} diff byte(s). Provider execution inside Vercel Sandbox is not enabled for this policy profile; no findings were emitted.\`,
  overall_confidence_score: 0
};
await writeFile(new URL('./review-output.json', import.meta.url), JSON.stringify(raw), 'utf8');
process.stdout.write('review-output.json\\n');
`;

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

function createRemoteSandboxPolicy() {
  const policy = createDefaultPolicy();
  policy.commandAllowlist = new Set(['node']);
  policy.networkProfile = 'deny_all';
  policy.allowlistDomains = [];
  policy.envAllowlist = new Set(['CI']);
  policy.budget = {
    maxWallTimeMs: 60_000,
    maxCommandTimeoutMs: 15_000,
    maxCommandCount: 1,
    maxOutputBytes: 256 * 1024,
    maxArtifactBytes: 512 * 1024,
  };
  return policy;
}

const runRemoteSandboxReview: SandboxReviewRunner = async (input) => {
  const payload = {
    request: {
      target: input.request.target,
      provider: input.request.provider,
      model: input.request.model ?? null,
      severityThreshold: input.request.severityThreshold ?? null,
    },
    resolvedPrompt: input.resolvedPrompt,
    rubric: input.rubric,
    normalizedDiffChunks: input.normalizedDiffChunks,
  };
  const sandboxResult = await runInSandbox({
    files: [
      {
        path: 'review-input.json',
        content: Buffer.from(JSON.stringify(payload), 'utf8'),
      },
      {
        path: 'review-runner.mjs',
        content: Buffer.from(SANDBOX_REVIEW_RUNNER, 'utf8'),
      },
    ],
    commands: [
      {
        cmd: 'node',
        args: ['review-runner.mjs'],
        cwd: SANDBOX_ROOT,
        timeoutMs: 15_000,
        env: { CI: '1' },
      },
    ],
    artifacts: [{ path: 'review-output.json' }],
    policy: createRemoteSandboxPolicy(),
    runtime: 'node24',
  });
  const command = sandboxResult.outputs[0];
  if (!command || command.exitCode !== 0) {
    throw new Error(
      `remote sandbox review failed: ${command?.stderr || command?.stdout || `exit ${command?.exitCode ?? 'unknown'}`}`
    );
  }

  const artifact = sandboxResult.artifacts.find(
    (candidate) => candidate.path === 'review-output.json'
  );
  if (!artifact) {
    throw new Error('remote sandbox review did not produce review-output.json');
  }

  const raw = JSON.parse(artifact.content) as RawModelOutput;
  const sandboxAudit: SandboxAudit = {
    sandboxId: sandboxResult.sandboxId,
    ...sandboxResult.audit,
  };
  return {
    raw,
    text: artifact.content,
    resolvedModel: 'remoteSandbox:policy-runner',
    sandboxAudit,
  };
};

function withProviders(request: ReviewRequest): Promise<ReviewRunResult> {
  return runReview(request, {
    providers,
    ...(request.executionMode === 'remoteSandbox'
      ? { sandboxRunner: runRemoteSandboxReview }
      : {}),
  });
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
    if (record.result.sandboxAudit) {
      record.sandboxId = record.result.sandboxAudit.sandboxId;
    }
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
