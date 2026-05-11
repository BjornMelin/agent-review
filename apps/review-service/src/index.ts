import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { ConvexMetadataBridge } from '@review-agent/review-convex-bridge';
import { runReview } from '@review-agent/review-core';
import { createCodexDelegateProvider } from '@review-agent/review-provider-codex';
import { createOpenAICompatibleReviewProvider } from '@review-agent/review-provider-openai';
import {
  ARTIFACT_CONTENT_TYPES,
  type CorrelationIds,
  isTerminalReviewRunStatus,
  type LifecycleEvent,
  OutputFormatSchema,
  type ReviewCancelResponse,
  type ReviewErrorResponse,
  type ReviewRequest,
  type ReviewRunStatus,
  ReviewStartRequestSchema,
  type ReviewStartResponse,
  type ReviewStatusResponse,
} from '@review-agent/review-types';
import { ReviewWorker } from '@review-agent/review-worker';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

type ReviewRecord = {
  reviewId: string;
  status: ReviewRunStatus;
  request: ReviewRequest;
  createdAt: number;
  updatedAt: number;
  result?: Awaited<ReturnType<typeof runReview>>;
  error?: string;
  detachedRunId?: string;
  events: LifecycleEvent[];
  listeners: Set<(event: LifecycleEvent) => void | Promise<void>>;
};

const providers = {
  codexDelegate: createCodexDelegateProvider(),
  openaiCompatible: createOpenAICompatibleReviewProvider(),
};

const worker = new ReviewWorker();
const bridge = new ConvexMetadataBridge();
const records = new Map<string, ReviewRecord>();
const UNSUPPORTED_REMOTE_SANDBOX_ERROR =
  'executionMode "remoteSandbox" is not supported by review-service';
const MAX_RECORDS = 500;
const MAX_RECORD_AGE_MS = 60 * 60 * 1000;
const MAX_RECORD_EVENTS = 200;
const RECORD_CLEANUP_INTERVAL_MS = 60_000;

function cleanupReviewRecords(): void {
  const now = Date.now();
  for (const [reviewId, record] of records) {
    if (
      isTerminalReviewRunStatus(record.status) &&
      now - record.updatedAt > MAX_RECORD_AGE_MS
    ) {
      record.listeners.clear();
      record.events.length = 0;
      records.delete(reviewId);
    }
  }

  if (records.size <= MAX_RECORDS) {
    return;
  }

  const evictOrder = [...records.entries()].sort(
    (a, b) => a[1].updatedAt - b[1].updatedAt
  );
  for (const [reviewId, record] of evictOrder) {
    if (records.size <= MAX_RECORDS) {
      break;
    }
    if (isTerminalReviewRunStatus(record.status)) {
      record.listeners.clear();
      record.events.length = 0;
      records.delete(reviewId);
    }
  }
}

const recordsCleanupInterval = setInterval(
  cleanupReviewRecords,
  RECORD_CLEANUP_INTERVAL_MS
);
recordsCleanupInterval.unref?.();

const app = new Hono();

type LifecycleEventPayload = {
  [TType in LifecycleEvent['type']]: Omit<
    Extract<LifecycleEvent, { type: TType }>,
    'meta'
  >;
}[LifecycleEvent['type']];

function getRecord(reviewId: string): ReviewRecord {
  const record = records.get(reviewId);
  if (!record) {
    throw new Error(`review ${reviewId} not found`);
  }
  return record;
}

function emit(
  record: ReviewRecord,
  event: LifecycleEvent | LifecycleEventPayload,
  correlationOverride?: Partial<CorrelationIds>
): LifecycleEvent {
  const enriched: LifecycleEvent =
    'meta' in event
      ? {
          ...event,
          meta: {
            ...event.meta,
            correlation: {
              ...event.meta.correlation,
              reviewId: record.reviewId,
              workflowRunId:
                record.detachedRunId ?? event.meta.correlation.workflowRunId,
              ...(correlationOverride ?? {}),
            },
          },
        }
      : {
          ...event,
          meta: {
            eventId: randomUUID(),
            timestampMs: Date.now(),
            correlation: {
              reviewId: record.reviewId,
              workflowRunId: record.detachedRunId,
              ...(correlationOverride ?? {}),
            },
          },
        };

  if (record.events.length >= MAX_RECORD_EVENTS) {
    record.events.shift();
  }
  record.events.push(enriched);

  for (const listener of [...record.listeners]) {
    try {
      const result = listener(enriched);
      if (result instanceof Promise) {
        result.catch(() => {
          console.error(
            `[review-service] dropping failed lifecycle listener for ${record.reviewId}:`,
            'listener promise rejected'
          );
          record.listeners.delete(listener);
        });
      }
    } catch (error) {
      console.error(
        `[review-service] dropping failed lifecycle listener for ${record.reviewId}:`,
        error
      );
      record.listeners.delete(listener);
    }
  }
  return enriched;
}

async function runInline(record: ReviewRecord): Promise<void> {
  try {
    record.status = 'running';
    record.updatedAt = Date.now();
    emit(record, { type: 'progress', message: 'starting inline review run' });

    if (record.request.executionMode === 'remoteSandbox') {
      throw new Error(UNSUPPORTED_REMOTE_SANDBOX_ERROR);
    }

    const review = await runReview(
      record.request,
      {
        providers,
        onEvent: (event) => emit(record, event),
        correlation: {
          workflowRunId: record.detachedRunId,
        },
      },
      bridge
    );
    record.result = review;
    record.status = 'completed';
    record.updatedAt = Date.now();
  } catch (error) {
    record.status = 'failed';
    record.error = error instanceof Error ? error.message : String(error);
    record.updatedAt = Date.now();
    emit(record, { type: 'failed', message: record.error });
  }
}

app.post('/v1/review/start', async (c) => {
  try {
    const body = await c.req.json();
    const { request, delivery } = ReviewStartRequestSchema.parse(body);
    if (request.executionMode === 'remoteSandbox') {
      const response: ReviewErrorResponse = {
        error: UNSUPPORTED_REMOTE_SANDBOX_ERROR,
      };
      return c.json(response, 400);
    }

    const reviewId = randomUUID();
    const record: ReviewRecord = {
      reviewId,
      status: 'queued',
      request,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      events: [],
      listeners: new Set(),
    };
    cleanupReviewRecords();

    if (delivery === 'detached' || request.detached) {
      const detached = await worker.startDetached(request);
      record.detachedRunId = detached.runId;
      record.status = detached.status === 'running' ? 'running' : 'queued';
      record.updatedAt = Date.now();
      records.set(reviewId, record);
      emit(record, { type: 'enteredReviewMode', review: 'review requested' });
      const response: ReviewStartResponse = {
        reviewId,
        status: record.status,
        detachedRunId: detached.runId,
      };
      return c.json(response, 202);
    }

    records.set(reviewId, record);
    await runInline(record);
    const response: ReviewStartResponse = {
      reviewId,
      status: record.status,
      ...(record.result ? { result: record.result.result } : {}),
    };
    return c.json(response, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const response: ReviewErrorResponse = { error: message };
    return c.json(response, 400);
  }
});

app.get('/v1/review/:reviewId', async (c) => {
  try {
    const record = getRecord(c.req.param('reviewId'));
    if (
      record.detachedRunId &&
      (record.status === 'queued' || record.status === 'running')
    ) {
      const detached = await worker.get(record.detachedRunId);
      if (detached) {
        const previousStatus = record.status;
        const previousError = record.error;

        record.status = detached.status;
        if (detached.status === 'completed' && detached.result) {
          record.result = detached.result;
          if (record.result) {
            record.updatedAt = Date.now();
          }
        }
        if (detached.status === 'failed') {
          record.error = detached.error ?? 'detached run failed';
          if (record.error !== previousError) {
            record.updatedAt = Date.now();
          }
        }
        if (record.status !== previousStatus) {
          record.updatedAt = Date.now();
        }
      }
    }

    const response: ReviewStatusResponse = {
      reviewId: record.reviewId,
      status: record.status,
      ...(record.error ? { error: record.error } : {}),
      ...(record.result ? { result: record.result.result } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    return c.json(response);
  } catch (error) {
    const response: ReviewErrorResponse = { error: String(error) };
    return c.json(response, 404);
  }
});

app.get('/v1/review/:reviewId/events', async (c) => {
  const record = records.get(c.req.param('reviewId'));
  if (!record) {
    const response: ReviewErrorResponse = { error: 'review not found' };
    return c.json(response, 404);
  }

  return streamSSE(c, async (stream) => {
    const send = async (event: LifecycleEvent) => {
      await stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
        id: event.meta.eventId,
        retry: 1000,
      });
    };

    for (const event of record.events) {
      await send(event);
    }

    record.listeners.add(send);

    const heartbeat = setInterval(() => {
      void stream.writeSSE({
        event: 'keepalive',
        data: '',
      });
    }, 15000);

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      clearInterval(heartbeat);
      record.listeners.delete(send);
    };

    stream.onAbort(() => {
      cleanup();
    });

    const streamWithError = stream as {
      onError?: (callback: (error: unknown) => void) => void;
    };
    streamWithError.onError?.((error) => {
      console.error('[review-service] events stream error', error);
      cleanup();
    });
  });
});

app.get('/v1/review/:reviewId/artifacts/:format', (c) => {
  const record = records.get(c.req.param('reviewId'));
  if (!record?.result) {
    const response: ReviewErrorResponse = { error: 'artifact not ready' };
    return c.json(response, 404);
  }

  const formatRaw = c.req.param('format');
  const formatResult = OutputFormatSchema.safeParse(formatRaw);
  if (!formatResult.success) {
    const response: ReviewErrorResponse = {
      error: `invalid artifact format ${formatRaw}`,
    };
    return c.json(response, 400);
  }

  const format = formatResult.data;
  const artifact = record.result.artifacts[format];
  if (!artifact) {
    const response: ReviewErrorResponse = {
      error: `artifact format ${format} not generated`,
    };
    return c.json(response, 404);
  }

  return new Response(artifact, {
    headers: {
      'Content-Type': ARTIFACT_CONTENT_TYPES[format],
    },
  });
});

app.post('/v1/review/:reviewId/cancel', async (c) => {
  const reviewId = c.req.param('reviewId');
  const record = records.get(reviewId);
  if (!record) {
    const response: ReviewErrorResponse = { error: 'review not found' };
    return c.json(response, 404);
  }

  if (record.detachedRunId) {
    const cancelled = await worker.cancel(record.detachedRunId);
    if (cancelled) {
      record.status = 'cancelled';
      record.updatedAt = Date.now();
      emit(record, { type: 'cancelled' });
      cleanupReviewRecords();
      const response: ReviewCancelResponse = {
        reviewId,
        status: record.status,
      };
      return c.json(response);
    }
  }

  const response: ReviewCancelResponse = {
    reviewId,
    status: record.status,
    cancelled: false,
  };
  return c.json(response, 409);
});

const port = Number.parseInt(process.env.PORT ?? '3042', 10);
console.error(`review-service listening on :${port}`);
serve({
  fetch: app.fetch,
  port,
});
