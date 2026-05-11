import { randomUUID } from 'node:crypto';
import type {
  MirrorWriteBridge,
  ReviewRunResult,
  RunReviewOptions,
} from '@review-agent/review-core';
import { runReview } from '@review-agent/review-core';
import {
  ARTIFACT_CONTENT_TYPES,
  type CorrelationIds,
  isTerminalReviewRunStatus,
  type LifecycleEvent,
  OutputFormatSchema,
  type ReviewCancelResponse,
  type ReviewErrorResponse,
  type ReviewProvider,
  type ReviewRequest,
  type ReviewRunStatus,
  ReviewStartRequestSchema,
  type ReviewStartResponse,
  type ReviewStatusResponse,
} from '@review-agent/review-types';
import type { DetachedRunRecord } from '@review-agent/review-worker';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

/**
 * Stores the mutable service state for one review request.
 */
export type ReviewRecord = {
  reviewId: string;
  status: ReviewRunStatus;
  request: ReviewRequest;
  createdAt: number;
  updatedAt: number;
  result?: ReviewRunResult;
  error?: string;
  detachedRunId?: string;
  events: LifecycleEvent[];
};

/**
 * Defines the service store boundary used by routes and future durable adapters.
 */
export type ReviewStoreAdapter = {
  get(reviewId: string): ReviewRecord | undefined;
  set(record: ReviewRecord): void;
  delete(reviewId: string): void;
  entries(): Iterable<[string, ReviewRecord]>;
  size(): number;
};

/**
 * Defines the detached worker operations used by the review service.
 */
export type ReviewServiceWorker = {
  startDetached(request: ReviewRequest): Promise<DetachedRunRecord>;
  get(runId: string): Promise<DetachedRunRecord | null>;
  cancel(runId: string): Promise<boolean>;
};

/**
 * Defines the injected review runner used for inline execution.
 */
export type ReviewServiceRunner = (
  request: ReviewRequest,
  options: RunReviewOptions,
  bridge?: MirrorWriteBridge
) => Promise<ReviewRunResult>;

/**
 * Defines the logger surface used by the service app factory.
 */
export type ReviewServiceLogger = {
  error(message?: unknown, ...optionalParams: unknown[]): void;
};

/**
 * Defines the request authorization hook used before service routes execute.
 */
export type ReviewServiceAuthPolicy = (
  context: Context
) => Response | null | Promise<Response | null>;

/**
 * Defines tunable service limits that do not change the route contract.
 */
export type ReviewServiceConfig = {
  maxRecords: number;
  maxRecordAgeMs: number;
  maxRecordEvents: number;
  recordCleanupIntervalMs: number | false;
  eventStreamPollIntervalMs: number;
  unsupportedRemoteSandboxError: string;
};

/**
 * Defines all dependencies required to construct an import-safe service app.
 */
export type ReviewServiceDependencies = {
  providers: Record<ReviewRequest['provider'], ReviewProvider>;
  worker: ReviewServiceWorker;
  bridge?: MirrorWriteBridge;
  store?: ReviewStoreAdapter;
  nowMs?: () => number;
  uuid?: () => string;
  logger?: ReviewServiceLogger;
  authPolicy?: ReviewServiceAuthPolicy;
  config?: Partial<ReviewServiceConfig>;
  runner?: ReviewServiceRunner;
};

const DEFAULT_CONFIG: ReviewServiceConfig = {
  maxRecords: 500,
  maxRecordAgeMs: 60 * 60 * 1000,
  maxRecordEvents: 200,
  recordCleanupIntervalMs: 60_000,
  eventStreamPollIntervalMs: 15_000,
  unsupportedRemoteSandboxError:
    'executionMode "remoteSandbox" is not supported by review-service',
};

type LifecycleEventPayload = {
  [TType in LifecycleEvent['type']]: Omit<
    Extract<LifecycleEvent, { type: TType }>,
    'meta'
  >;
}[LifecycleEvent['type']];
type ReviewLifecycleListener = (event: LifecycleEvent) => void | Promise<void>;

/**
 * Creates a process-local review store for one service app instance.
 *
 * @returns A mutable in-memory store adapter scoped to the created app.
 */
export function createInMemoryReviewStore(): ReviewStoreAdapter {
  const records = new Map<string, ReviewRecord>();
  return {
    get(reviewId) {
      return records.get(reviewId);
    },
    set(record) {
      records.set(record.reviewId, record);
    },
    delete(reviewId) {
      records.delete(reviewId);
    },
    entries() {
      return records.entries();
    },
    size() {
      return records.size;
    },
  };
}

function jsonError(
  context: Context,
  message: string,
  status: 400 | 404 | 409 | 502
): Response {
  const response: ReviewErrorResponse = { error: message };
  return context.json(response, status);
}

async function parseJsonBody<T>(
  context: Context,
  parse: (input: unknown) => T
): Promise<T> {
  const body = await context.req.json();
  return parse(body);
}

function createReviewRecord(
  request: ReviewRequest,
  reviewId: string,
  nowMs: number
): ReviewRecord {
  return {
    reviewId,
    status: 'queued',
    request,
    createdAt: nowMs,
    updatedAt: nowMs,
    events: [],
  };
}

function buildStatusResponse(record: ReviewRecord): ReviewStatusResponse {
  return {
    reviewId: record.reviewId,
    status: record.status,
    ...(record.error ? { error: record.error } : {}),
    ...(record.result ? { result: record.result.result } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Creates an import-safe Hono review service app with injected dependencies.
 *
 * @param dependencies - The providers, worker, store, clock, auth, and runner used by the app.
 * @returns A Hono app that can be tested with app.request or served by a runtime entrypoint.
 */
export function createReviewServiceApp(
  dependencies: ReviewServiceDependencies
): Hono {
  const config: ReviewServiceConfig = {
    ...DEFAULT_CONFIG,
    ...(dependencies.config ?? {}),
  };
  const store = dependencies.store ?? createInMemoryReviewStore();
  const nowMs = dependencies.nowMs ?? Date.now;
  const uuid = dependencies.uuid ?? randomUUID;
  const logger = dependencies.logger ?? console;
  const authPolicy = dependencies.authPolicy ?? (() => null);
  const runner = dependencies.runner ?? runReview;
  const app = new Hono();
  const liveListeners = new Map<string, Set<ReviewLifecycleListener>>();

  function getLiveListeners(reviewId: string): Set<ReviewLifecycleListener> {
    let listeners = liveListeners.get(reviewId);
    if (!listeners) {
      listeners = new Set();
      liveListeners.set(reviewId, listeners);
    }
    return listeners;
  }

  function removeLiveListener(
    reviewId: string,
    listener: ReviewLifecycleListener
  ): void {
    const listeners = liveListeners.get(reviewId);
    listeners?.delete(listener);
    if (listeners?.size === 0) {
      liveListeners.delete(reviewId);
    }
  }

  function clearLiveListeners(reviewId: string): void {
    liveListeners.delete(reviewId);
  }

  function cleanupReviewRecords(): void {
    const now = nowMs();
    for (const [reviewId, record] of store.entries()) {
      if (
        isTerminalReviewRunStatus(record.status) &&
        now - record.updatedAt > config.maxRecordAgeMs
      ) {
        record.events.length = 0;
        clearLiveListeners(reviewId);
        store.delete(reviewId);
      }
    }

    if (store.size() <= config.maxRecords) {
      return;
    }

    const evictOrder = [...store.entries()].sort(
      (a, b) => a[1].updatedAt - b[1].updatedAt
    );
    for (const [reviewId, record] of evictOrder) {
      if (store.size() <= config.maxRecords) {
        break;
      }
      if (isTerminalReviewRunStatus(record.status)) {
        record.events.length = 0;
        clearLiveListeners(reviewId);
        store.delete(reviewId);
      }
    }
  }

  if (config.recordCleanupIntervalMs !== false) {
    const cleanupInterval = setInterval(
      cleanupReviewRecords,
      config.recordCleanupIntervalMs
    );
    cleanupInterval.unref?.();
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
              eventId: uuid(),
              timestampMs: nowMs(),
              correlation: {
                reviewId: record.reviewId,
                workflowRunId: record.detachedRunId,
                ...(correlationOverride ?? {}),
              },
            },
          };

    if (record.events.length >= config.maxRecordEvents) {
      record.events.shift();
    }
    record.events.push(enriched);
    store.set(record);

    const listeners = liveListeners.get(record.reviewId);
    if (!listeners) {
      return enriched;
    }

    for (const listener of [...listeners]) {
      try {
        const result = listener(enriched);
        if (result instanceof Promise) {
          result.catch(() => {
            logger.error(
              `[review-service] dropping failed lifecycle listener for ${record.reviewId}:`,
              'listener promise rejected'
            );
            removeLiveListener(record.reviewId, listener);
          });
        }
      } catch (error) {
        logger.error(
          `[review-service] dropping failed lifecycle listener for ${record.reviewId}:`,
          error
        );
        removeLiveListener(record.reviewId, listener);
      }
    }
    return enriched;
  }

  async function runInline(record: ReviewRecord): Promise<void> {
    try {
      record.status = 'running';
      record.updatedAt = nowMs();
      emit(record, {
        type: 'progress',
        message: 'starting inline review run',
      });

      if (record.request.executionMode === 'remoteSandbox') {
        throw new Error(config.unsupportedRemoteSandboxError);
      }

      const review = await runner(
        record.request,
        {
          providers: dependencies.providers,
          onEvent: (event) => emit(record, event),
          now: () => new Date(nowMs()),
          correlation: {
            workflowRunId: record.detachedRunId,
          },
        },
        dependencies.bridge
      );
      record.result = review;
      record.status = 'completed';
      record.updatedAt = nowMs();
      store.set(record);
    } catch (error) {
      record.status = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      record.updatedAt = nowMs();
      emit(record, { type: 'failed', message: record.error });
      store.set(record);
    }
  }

  async function syncDetachedRecord(record: ReviewRecord): Promise<void> {
    if (
      !record.detachedRunId ||
      (record.status !== 'queued' && record.status !== 'running')
    ) {
      return;
    }

    const detached = await dependencies.worker.get(record.detachedRunId);
    if (!detached) {
      return;
    }

    const previousStatus = record.status;
    const previousError = record.error;
    let changed = false;

    record.status = detached.status;
    if (detached.status === 'completed' && detached.result) {
      record.result = detached.result;
      changed = true;
    }
    if (detached.status === 'failed') {
      record.error = detached.error ?? 'detached run failed';
      if (record.error !== previousError) {
        changed = true;
      }
    }
    if (record.status !== previousStatus) {
      changed = true;
      record.updatedAt = nowMs();
      if (record.status === 'failed') {
        emit(record, {
          type: 'failed',
          message: record.error ?? 'detached run failed',
        });
      }
      if (record.status === 'cancelled') {
        emit(record, { type: 'cancelled' });
      }
    } else if (changed) {
      record.updatedAt = nowMs();
    }

    if (changed) {
      store.set(record);
    }
  }

  app.use('/v1/*', async (context, next) => {
    const denied = await authPolicy(context);
    if (denied) {
      return denied;
    }
    await next();
  });

  app.post('/v1/review/start', async (context) => {
    try {
      const { request, delivery } = await parseJsonBody(context, (body) =>
        ReviewStartRequestSchema.parse(body)
      );
      if (request.executionMode === 'remoteSandbox') {
        return jsonError(context, config.unsupportedRemoteSandboxError, 400);
      }

      const reviewId = uuid();
      const record = createReviewRecord(request, reviewId, nowMs());
      cleanupReviewRecords();

      if (delivery === 'detached' || request.detached) {
        const detached = await dependencies.worker.startDetached(request);
        record.detachedRunId = detached.runId;
        record.status = detached.status === 'running' ? 'running' : 'queued';
        record.updatedAt = nowMs();
        store.set(record);
        emit(record, {
          type: 'enteredReviewMode',
          review: 'review requested',
        });
        const response: ReviewStartResponse = {
          reviewId,
          status: record.status,
          detachedRunId: detached.runId,
        };
        return context.json(response, 202);
      }

      store.set(record);
      await runInline(record);
      const response: ReviewStartResponse = {
        reviewId,
        status: record.status,
        ...(record.result ? { result: record.result.result } : {}),
      };
      return context.json(response, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonError(context, message, 400);
    }
  });

  app.get('/v1/review/:reviewId', async (context) => {
    const record = store.get(context.req.param('reviewId'));
    if (!record) {
      return jsonError(context, 'review not found', 404);
    }

    try {
      await syncDetachedRecord(record);
      return context.json(buildStatusResponse(record));
    } catch (error) {
      logger.error('[review-service] failed to fetch run status', error);
      return jsonError(context, 'failed to fetch run status', 502);
    }
  });

  app.get('/v1/review/:reviewId/events', async (context) => {
    const record = store.get(context.req.param('reviewId'));
    if (!record) {
      return jsonError(context, 'review not found', 404);
    }

    try {
      await syncDetachedRecord(record);
    } catch (error) {
      logger.error(
        '[review-service] failed to sync event stream status',
        error
      );
      return jsonError(context, 'failed to fetch event stream status', 502);
    }

    return streamSSE(context, async (stream) => {
      let streaming = true;
      let cleanedUp = false;
      const deliveredEventIds = new Set<string>();
      let writeQueue = Promise.resolve();

      const writeQueuedSse = (
        frame: Parameters<typeof stream.writeSSE>[0]
      ): Promise<void> => {
        writeQueue = writeQueue.then(() => stream.writeSSE(frame));
        return writeQueue;
      };

      const send = async (event: LifecycleEvent) => {
        if (deliveredEventIds.has(event.meta.eventId)) {
          return writeQueue;
        }
        deliveredEventIds.add(event.meta.eventId);
        return writeQueuedSse({
          event: event.type,
          data: JSON.stringify(event),
          id: event.meta.eventId,
          retry: 1000,
        });
      };

      const cleanup = () => {
        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        streaming = false;
        removeLiveListener(record.reviewId, send);
      };

      getLiveListeners(record.reviewId).add(send);

      for (const event of record.events) {
        await send(event);
      }

      stream.onAbort(() => {
        cleanup();
      });

      const streamWithError = stream as {
        onError?: (callback: (error: unknown) => void) => void;
      };
      streamWithError.onError?.((error) => {
        logger.error('[review-service] events stream error', error);
        cleanup();
      });

      try {
        while (streaming) {
          await stream.sleep(config.eventStreamPollIntervalMs);
          if (!streaming) {
            break;
          }
          const latestRecord = store.get(record.reviewId);
          if (!latestRecord) {
            cleanup();
            break;
          }
          await syncDetachedRecord(latestRecord);
          if (!streaming) {
            break;
          }
          await writeQueuedSse({
            event: 'keepalive',
            data: '',
          });
        }
      } catch (error) {
        logger.error('[review-service] events stream error', error);
      } finally {
        cleanup();
      }
    });
  });

  app.get('/v1/review/:reviewId/artifacts/:format', async (context) => {
    const record = store.get(context.req.param('reviewId'));
    if (!record) {
      return jsonError(context, 'artifact not ready', 404);
    }

    try {
      await syncDetachedRecord(record);
    } catch (error) {
      logger.error('[review-service] failed to sync artifact status', error);
      return jsonError(context, 'failed to fetch artifact status', 502);
    }

    if (!record.result) {
      return jsonError(context, 'artifact not ready', 404);
    }

    const formatRaw = context.req.param('format');
    const formatResult = OutputFormatSchema.safeParse(formatRaw);
    if (!formatResult.success) {
      return jsonError(context, `invalid artifact format ${formatRaw}`, 400);
    }

    const format = formatResult.data;
    const artifact = record.result.artifacts[format];
    if (!artifact) {
      return jsonError(context, `artifact format ${format} not generated`, 404);
    }

    return new Response(artifact, {
      headers: {
        'Content-Type': ARTIFACT_CONTENT_TYPES[format],
      },
    });
  });

  app.post('/v1/review/:reviewId/cancel', async (context) => {
    const reviewId = context.req.param('reviewId');
    const record = store.get(reviewId);
    if (!record) {
      return jsonError(context, 'review not found', 404);
    }

    if (record.detachedRunId) {
      try {
        const cancelled = await dependencies.worker.cancel(
          record.detachedRunId
        );
        if (cancelled) {
          record.status = 'cancelled';
          record.updatedAt = nowMs();
          emit(record, { type: 'cancelled' });
          store.set(record);
          cleanupReviewRecords();
          const response: ReviewCancelResponse = {
            reviewId,
            status: record.status,
          };
          return context.json(response);
        }
        await syncDetachedRecord(record);
      } catch (error) {
        logger.error('[review-service] failed to cancel run', error);
        return jsonError(context, 'failed to cancel run', 502);
      }
    }

    const response: ReviewCancelResponse = {
      reviewId,
      status: record.status,
      cancelled: false,
    };
    return context.json(response, 409);
  });

  return app;
}
