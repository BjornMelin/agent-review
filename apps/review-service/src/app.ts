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
  ReviewEventCursorSchema,
  type ReviewProvider,
  type ReviewRequest,
  ReviewStartRequestSchema,
  type ReviewStartResponse,
  type ReviewStatusResponse,
} from '@review-agent/review-types';
import type { DetachedRunRecord } from '@review-agent/review-worker';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  createInMemoryReviewStore,
  type ReviewRecord,
  type ReviewStoreAdapter,
} from './storage/index.js';

/**
 * Re-exports review store records and adapters for service consumers and tests.
 */
export type { ReviewRecord, ReviewStoreAdapter } from './storage/index.js';
/**
 * Re-exports service store factories used by the production server and tests.
 */
export {
  createInMemoryReviewStore,
  createReviewStoreFromEnv,
} from './storage/index.js';

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
type ReviewEventCursor = ReturnType<typeof ReviewEventCursorSchema.parse>;
type ReviewLifecycleListener = (event: LifecycleEvent) => void | Promise<void>;

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

function parseEventCursor(
  context: Context,
  reviewId: string
): ReviewEventCursor {
  const limitRaw = context.req.query('limit');
  return ReviewEventCursorSchema.parse({
    reviewId,
    afterEventId:
      context.req.query('afterEventId') ??
      context.req.header('last-event-id') ??
      undefined,
    ...(limitRaw === undefined ? {} : { limit: Number(limitRaw) }),
  });
}

function selectReplayEvents(
  events: LifecycleEvent[],
  cursor: ReviewEventCursor
): LifecycleEvent[] {
  if (!cursor.afterEventId) {
    return events.slice(0, cursor.limit);
  }
  const cursorIndex = events.findIndex(
    (event) => event.meta.eventId === cursor.afterEventId
  );
  if (cursorIndex === -1) {
    return [];
  }
  return events.slice(cursorIndex + 1, cursorIndex + 1 + cursor.limit);
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

  function setTerminalRetention(record: ReviewRecord): void {
    record.retentionExpiresAt = record.updatedAt + config.maxRecordAgeMs;
  }

  function detachedTerminalMeta(
    record: ReviewRecord,
    suffix: string
  ): LifecycleEvent['meta'] {
    return {
      eventId: `detached:${record.reviewId}:${record.detachedRunId ?? 'unknown'}:${suffix}`,
      timestampMs: record.updatedAt,
      correlation: {
        reviewId: record.reviewId,
        workflowRunId: record.workflowRunId ?? record.detachedRunId,
      },
    };
  }

  async function cleanupReviewRecords(): Promise<void> {
    const deletedReviewIds = await store.cleanup({
      nowMs: nowMs(),
    });
    for (const reviewId of deletedReviewIds) {
      clearLiveListeners(reviewId);
    }
  }

  async function loadRecord(
    context: Context,
    reviewId: string,
    notFoundMessage: string,
    failureMessage: string
  ): Promise<ReviewRecord | Response> {
    try {
      const record = await store.get(reviewId);
      return record ?? jsonError(context, notFoundMessage, 404);
    } catch (error) {
      logger.error(`[review-service] ${failureMessage}`, error);
      return jsonError(context, failureMessage, 502);
    }
  }

  if (config.recordCleanupIntervalMs !== false) {
    const cleanupInterval = setInterval(() => {
      cleanupReviewRecords().catch((error) => {
        logger.error('[review-service] cleanup failed', error);
      });
    }, config.recordCleanupIntervalMs);
    cleanupInterval.unref?.();
  }

  async function emit(
    record: ReviewRecord,
    event: LifecycleEvent | LifecycleEventPayload,
    correlationOverride?: Partial<CorrelationIds>
  ): Promise<LifecycleEvent> {
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
                  record.workflowRunId ??
                  record.detachedRunId ??
                  event.meta.correlation.workflowRunId,
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
                workflowRunId: record.workflowRunId ?? record.detachedRunId,
                ...(correlationOverride ?? {}),
              },
            },
          };

    await store.appendEvent(record, enriched, {
      maxEvents: config.maxRecordEvents,
      reason: 'lifecycle event',
    });

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
      await emit(record, {
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
          onEvent: async (event) => {
            await emit(record, event);
          },
          now: () => new Date(nowMs()),
          correlation: {
            workflowRunId: record.workflowRunId ?? record.detachedRunId,
          },
        },
        dependencies.bridge
      );
      record.result = review;
      record.status = 'completed';
      record.updatedAt = nowMs();
      setTerminalRetention(record);
      await store.set(record, { reason: 'inline completed' });
    } catch (error) {
      record.status = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      record.updatedAt = nowMs();
      setTerminalRetention(record);
      await emit(record, { type: 'failed', message: record.error });
      await store.set(record, { reason: 'inline failed' });
    }
  }

  async function emitDetachedTerminalEvents(
    record: ReviewRecord
  ): Promise<void> {
    if (record.status === 'failed') {
      await emit(record, {
        type: 'failed',
        message: record.error ?? 'detached run failed',
        meta: detachedTerminalMeta(record, 'failed'),
      });
      return;
    }
    if (record.status === 'completed' && record.result) {
      await emit(record, {
        type: 'exitedReviewMode',
        review: record.result.result.overallExplanation,
        meta: detachedTerminalMeta(record, 'completed:exited'),
      });
      for (const format of Object.keys(record.result.artifacts) as Array<
        keyof ReviewRunResult['artifacts']
      >) {
        await emit(record, {
          type: 'artifactReady',
          format,
          meta: detachedTerminalMeta(record, `completed:artifact:${format}`),
        });
      }
      return;
    }
    if (record.status === 'cancelled') {
      await emit(record, {
        type: 'cancelled',
        meta: detachedTerminalMeta(record, 'cancelled'),
      });
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
    const previousWorkflowRunId = record.workflowRunId;
    let changed = false;

    record.workflowRunId = detached.workflowRunId ?? detached.runId;
    record.status = detached.status;
    if (record.workflowRunId !== previousWorkflowRunId) {
      changed = true;
    }
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
      if (
        record.status === 'completed' ||
        record.status === 'failed' ||
        record.status === 'cancelled'
      ) {
        setTerminalRetention(record);
      }
      await emitDetachedTerminalEvents(record);
    } else if (changed) {
      record.updatedAt = nowMs();
    }

    if (changed) {
      await store.set(record, { reason: 'detached sync' });
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
    let parsed: ReturnType<typeof ReviewStartRequestSchema.parse>;
    try {
      parsed = await parseJsonBody(context, (body) =>
        ReviewStartRequestSchema.parse(body)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonError(context, message, 400);
    }

    try {
      const { request, delivery } = parsed;
      if (request.executionMode === 'remoteSandbox') {
        return jsonError(context, config.unsupportedRemoteSandboxError, 400);
      }

      const reviewId = uuid();
      const record = createReviewRecord(request, reviewId, nowMs());
      await cleanupReviewRecords();

      if (delivery === 'detached' || request.detached) {
        await store.set(record, { reason: 'detached queued' });
        let detached: DetachedRunRecord;
        try {
          detached = await dependencies.worker.startDetached(request);
        } catch (error) {
          record.status = 'failed';
          record.error = error instanceof Error ? error.message : String(error);
          record.updatedAt = nowMs();
          setTerminalRetention(record);
          await emit(record, {
            type: 'failed',
            message: record.error,
            meta: detachedTerminalMeta(record, 'start:failed'),
          });
          await store.set(record, { reason: 'detached start failed' });
          throw error;
        }
        record.detachedRunId = detached.runId;
        record.workflowRunId = detached.workflowRunId ?? detached.runId;
        record.status = detached.status;
        if (detached.result) {
          record.result = detached.result;
        }
        if (detached.error) {
          record.error = detached.error;
        }
        record.updatedAt = nowMs();
        if (isTerminalReviewRunStatus(record.status)) {
          setTerminalRetention(record);
        }
        await store.set(record, { reason: 'detached started' });
        await emit(record, {
          type: 'enteredReviewMode',
          review: 'review requested',
        });
        if (isTerminalReviewRunStatus(record.status)) {
          await emitDetachedTerminalEvents(record);
        }
        const response: ReviewStartResponse = {
          reviewId,
          status: record.status,
          detachedRunId: detached.runId,
        };
        return context.json(response, 202);
      }

      await store.set(record, { reason: 'inline queued' });
      await runInline(record);
      const response: ReviewStartResponse = {
        reviewId,
        status: record.status,
        ...(record.result ? { result: record.result.result } : {}),
      };
      return context.json(response, 200);
    } catch (error) {
      logger.error('[review-service] failed to start review', error);
      return jsonError(context, 'failed to start review', 502);
    }
  });

  app.get('/v1/review/:reviewId', async (context) => {
    const record = await loadRecord(
      context,
      context.req.param('reviewId'),
      'review not found',
      'failed to fetch run status'
    );
    if (record instanceof Response) {
      return record;
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
    const reviewId = context.req.param('reviewId');
    const record = await loadRecord(
      context,
      reviewId,
      'review not found',
      'failed to fetch event stream status'
    );
    if (record instanceof Response) {
      return record;
    }

    let cursor: ReviewEventCursor;
    try {
      cursor = parseEventCursor(context, reviewId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonError(context, message, 400);
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

      for (const event of selectReplayEvents(record.events, cursor)) {
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
          const latestRecord = await store.get(record.reviewId);
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
    const record = await loadRecord(
      context,
      context.req.param('reviewId'),
      'artifact not ready',
      'failed to fetch artifact status'
    );
    if (record instanceof Response) {
      return record;
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
    const record = await loadRecord(
      context,
      reviewId,
      'review not found',
      'failed to cancel run'
    );
    if (record instanceof Response) {
      return record;
    }

    if (isTerminalReviewRunStatus(record.status)) {
      const response: ReviewCancelResponse = {
        reviewId,
        status: record.status,
        cancelled: false,
      };
      return context.json(response, 409);
    }

    if (record.detachedRunId) {
      try {
        const cancelled = await dependencies.worker.cancel(
          record.detachedRunId
        );
        if (cancelled) {
          record.status = 'cancelled';
          record.updatedAt = nowMs();
          setTerminalRetention(record);
          await emit(record, {
            type: 'cancelled',
            meta: detachedTerminalMeta(record, 'cancelled'),
          });
          await store.set(record, { reason: 'cancelled' });
          await cleanupReviewRecords();
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
