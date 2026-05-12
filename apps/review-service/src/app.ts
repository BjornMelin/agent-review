import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  MirrorWriteBridge,
  ReviewRunResult,
  RunReviewOptions,
} from '@review-agent/review-core';
import {
  ReviewRunCancelledError,
  redactReviewRequest,
  redactReviewRunResult,
  runReview,
} from '@review-agent/review-core';
import {
  ARTIFACT_CONTENT_TYPES,
  type CorrelationIds,
  DEFAULT_REVIEW_SECURITY_LIMITS,
  isTerminalReviewRunStatus,
  type LifecycleEvent,
  OutputFormatSchema,
  type ReviewCancelResponse,
  type ReviewErrorResponse,
  ReviewEventCursorSchema,
  type ReviewProvider,
  type ReviewRequest,
  type ReviewRunAuthorization,
  type ReviewSecurityLimits,
  ReviewStartRequestSchema,
  type ReviewStartResponse,
  type ReviewStatusResponse,
  redactErrorMessage,
  redactLifecycleEvent,
  redactReviewResult,
  resolveReviewSecurityLimits,
  withReviewRequestSecurityDefaults,
} from '@review-agent/review-types';
import type { DetachedRunRecord } from '@review-agent/review-worker';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import {
  AuthHttpError,
  authHttpErrorResponse,
  authorizeRepositoryForRequest,
  isAuthHttpError,
  type ReviewAuthenticatedRequest,
  type ReviewServiceAuthOperation,
  type ReviewServiceAuthPolicy,
  repositorySelectionFromAuthorization,
  reviewRequestHash,
} from './auth.js';
import {
  createInMemoryReviewStore,
  type ReviewAuthStoreAdapter,
  type ReviewRecord,
  type ReviewStoreAdapter,
} from './storage/index.js';

/**
 * Re-exports hosted authentication context and auth policy types.
 */
export type {
  ReviewAuthenticatedRequest,
  ReviewServiceAuthPolicy,
} from './auth.js';
/**
 * Re-exports review store records and adapters for service consumers and tests.
 */
export type {
  ReviewAuthStoreAdapter,
  ReviewRecord,
  ReviewStoreAdapter,
} from './storage/index.js';
/**
 * Re-exports service store factories used by the production server and tests.
 */
export {
  createInMemoryReviewAuthStore,
  createInMemoryReviewStore,
  createReviewAuthStoreFromEnv,
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
 * Controls whether hosted API routes require an authenticated principal.
 */
export type ReviewServiceAuthMode = 'required' | 'disabled';

/**
 * Defines tunable service limits that do not change the route contract.
 */
export type ReviewServiceConfig = {
  allowedCwdRoots: string[];
  hostedRepositoryRoots: string[];
  maxRequestBodyBytes: number;
  maxRecordAgeMs: number;
  maxRecordEvents: number;
  maxQueuedRuns: number;
  maxRunningRuns: number;
  maxActiveRunsPerScope: number;
  runtimeLeaseTtlMs: number;
  recordCleanupIntervalMs: number | false;
  eventStreamPollIntervalMs: number;
  githubStreamAuthorizationTtlMs: number;
  remoteSandboxInlineError: string;
  reviewLimits: ReviewSecurityLimits;
};

/**
 * Defines partial service config accepted by the app factory.
 */
export type ReviewServiceConfigInput = Omit<
  Partial<ReviewServiceConfig>,
  'reviewLimits'
> & {
  reviewLimits?: Partial<ReviewSecurityLimits>;
};

/**
 * Defines all dependencies required to construct an import-safe service app.
 */
export type ReviewServiceDependencies = {
  providers: Record<ReviewRequest['provider'], ReviewProvider>;
  worker: ReviewServiceWorker;
  bridge?: MirrorWriteBridge;
  store?: ReviewStoreAdapter;
  authStore?: ReviewAuthStoreAdapter;
  nowMs?: () => number;
  uuid?: () => string;
  logger?: ReviewServiceLogger;
  authMode?: ReviewServiceAuthMode;
  authPolicy?: ReviewServiceAuthPolicy;
  config?: ReviewServiceConfigInput;
  runner?: ReviewServiceRunner;
};

const DEFAULT_CONFIG: ReviewServiceConfig = {
  allowedCwdRoots: [process.cwd()],
  hostedRepositoryRoots: [process.cwd()],
  maxRequestBodyBytes: 256 * 1024,
  maxRecordAgeMs: 60 * 60 * 1000,
  maxRecordEvents: 200,
  maxQueuedRuns: 100,
  maxRunningRuns: 10,
  maxActiveRunsPerScope: 2,
  runtimeLeaseTtlMs: 10 * 60 * 1000,
  recordCleanupIntervalMs: 60_000,
  eventStreamPollIntervalMs: 15_000,
  githubStreamAuthorizationTtlMs: 60_000,
  remoteSandboxInlineError:
    'executionMode "remoteSandbox" requires detached delivery',
  reviewLimits: DEFAULT_REVIEW_SECURITY_LIMITS,
};

const REMOTE_SANDBOX_UNSUPPORTED_TARGET_ERROR =
  'executionMode "remoteSandbox" currently supports only custom targets until sandbox source binding is implemented';
const RUNTIME_LEASE_OWNER = 'review-service';

type LifecycleEventPayload = {
  [TType in LifecycleEvent['type']]: Omit<
    Extract<LifecycleEvent, { type: TType }>,
    'meta'
  >;
}[LifecycleEvent['type']];
type ReviewEventCursor = ReturnType<typeof ReviewEventCursorSchema.parse>;
type ReviewLifecycleListener = (event: LifecycleEvent) => void | Promise<void>;

class RuntimeBackpressureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeBackpressureError';
  }
}

class ReviewRequestPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewRequestPolicyError';
  }
}

class AuthAuditWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthAuditWriteError';
  }
}

function jsonError(
  context: Context,
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 502,
  headers: Record<string, string> = {}
): Response {
  const response: ReviewErrorResponse = { error: message };
  const output = context.json(response, status);
  for (const [key, value] of Object.entries(headers)) {
    output.headers.set(key, value);
  }
  return output;
}

function authRequiredResponse(context: Context): Response {
  return jsonError(context, 'authentication required', 401, {
    'WWW-Authenticate': 'Bearer',
  });
}

async function parseJsonBody<T>(
  context: Context,
  parse: (input: unknown) => T
): Promise<T> {
  const body = await context.req.json();
  return parse(body);
}

function canonicalizePath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function pathContains(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

function prepareReviewRequestForService(
  request: ReviewRequest,
  config: ReviewServiceConfig
): ReviewRequest {
  if (!isAbsolute(request.cwd)) {
    throw new ReviewRequestPolicyError('cwd must be an absolute path');
  }
  const canonicalCwd = canonicalizePath(request.cwd);
  const allowedRoots = config.allowedCwdRoots.map(canonicalizePath);
  const allowed = allowedRoots.some((root) => pathContains(root, canonicalCwd));
  if (!allowed) {
    throw new ReviewRequestPolicyError(
      'cwd is outside configured review roots'
    );
  }
  try {
    return withReviewRequestSecurityDefaults(
      {
        ...request,
        cwd: canonicalCwd,
      },
      config.reviewLimits
    );
  } catch (error) {
    throw new ReviewRequestPolicyError(
      redactErrorMessage(error, 'review request exceeds configured limits')
    );
  }
}

function assertCwdMatchesAuthorizedRepository(
  request: ReviewRequest,
  repository: ReviewRunAuthorization['repository'],
  config: ReviewServiceConfig
): void {
  const canonicalCwd = canonicalizePath(request.cwd);
  const expectedRoots = config.hostedRepositoryRoots.map((root) =>
    canonicalizePath(resolve(root, repository.owner, repository.name))
  );
  const allowed = expectedRoots.some((root) =>
    pathContains(root, canonicalCwd)
  );
  if (!allowed) {
    throw new ReviewRequestPolicyError(
      'cwd must resolve under the authorized repository checkout root'
    );
  }
}

function logError(
  logger: ReviewServiceLogger,
  message: string,
  error: unknown
): void {
  logger.error(message, redactErrorMessage(error));
}

function createReviewRecord(
  request: ReviewRequest,
  reviewId: string,
  nowMs: number,
  authorization?: ReviewRunAuthorization
): ReviewRecord {
  return {
    reviewId,
    status: 'queued',
    request,
    ...(authorization ? { authorization } : {}),
    createdAt: nowMs,
    updatedAt: nowMs,
    events: [],
  };
}

function runtimeScopeKeyForRequest(request: ReviewRequest): string {
  const resolvedCwd = resolve(request.cwd);
  let scopeCwd = resolvedCwd;
  try {
    scopeCwd = realpathSync.native(resolvedCwd);
  } catch {
    scopeCwd = resolvedCwd;
  }
  const target =
    request.target.type === 'baseBranch'
      ? `baseBranch:${request.target.branch}`
      : request.target.type === 'commit'
        ? `commit:${request.target.sha}`
        : request.target.type;
  return [request.executionMode, request.provider, scopeCwd, target].join('|');
}

function buildStatusResponse(record: ReviewRecord): ReviewStatusResponse {
  return {
    reviewId: record.reviewId,
    status: record.status,
    ...(record.error ? { error: redactErrorMessage(record.error) } : {}),
    ...(record.result
      ? { result: redactReviewResult(record.result.result).result }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

const REVIEW_AUTH_CONTEXT_KEY = 'reviewAuthContext';

function setReviewAuthContext(
  context: Context,
  authContext: ReviewAuthenticatedRequest
): void {
  context.set(REVIEW_AUTH_CONTEXT_KEY, authContext);
}

function getReviewAuthContext(
  context: Context
): ReviewAuthenticatedRequest | undefined {
  return context.get(REVIEW_AUTH_CONTEXT_KEY) as
    | ReviewAuthenticatedRequest
    | undefined;
}

function actorForAuth(auth: ReviewAuthenticatedRequest): string {
  return auth.principal.type === 'githubUser'
    ? `github:${auth.principal.login}`
    : `service-token:${auth.principal.tokenId}`;
}

function scopeForOperation(
  operation: ReviewServiceAuthOperation
): ReviewRunAuthorization['scopes'][number] {
  switch (operation) {
    case 'review:start':
      return 'review:start';
    case 'review:read':
      return 'review:read';
    case 'review:cancel':
      return 'review:cancel';
    case 'review:publish':
      return 'review:publish';
  }
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
 * @throws Error - When an unexpected dependency failure escapes route construction or request handling.
 */
export function createReviewServiceApp(
  dependencies: ReviewServiceDependencies
): Hono {
  const config: ReviewServiceConfig = {
    ...DEFAULT_CONFIG,
    ...(dependencies.config ?? {}),
    reviewLimits: resolveReviewSecurityLimits({
      ...DEFAULT_CONFIG.reviewLimits,
      ...(dependencies.config?.reviewLimits ?? {}),
    }),
  };
  const store = dependencies.store ?? createInMemoryReviewStore();
  const nowMs = dependencies.nowMs ?? Date.now;
  const uuid = dependencies.uuid ?? randomUUID;
  const logger = dependencies.logger ?? console;
  const authMode = dependencies.authMode ?? 'required';
  const authPolicy = dependencies.authPolicy;
  const authStore = dependencies.authStore;
  if (authMode !== 'disabled' && authPolicy && !authStore) {
    throw new Error(
      'authStore is required when hosted auth is enabled so appendAuthAudit can persist authorization decisions'
    );
  }
  const runner = dependencies.runner ?? runReview;
  const app = new Hono();
  const liveListeners = new Map<string, Set<ReviewLifecycleListener>>();

  async function appendAuthAudit(input: {
    operation: ReviewServiceAuthOperation;
    result: 'allowed' | 'denied';
    reason: string;
    status: number;
    auth?: ReviewAuthenticatedRequest;
    authorization?: ReviewRunAuthorization;
    reviewId?: string;
    requestId?: string;
  }): Promise<void> {
    if (!authStore) {
      return;
    }
    try {
      await authStore.appendAuthAuditEvent({
        auditEventId: uuid(),
        eventType: 'authz',
        operation: input.operation,
        result: input.result,
        reason: input.reason,
        status: input.status,
        ...(input.auth ? { principal: input.auth.principal } : {}),
        ...(input.auth?.tokenId ? { tokenId: input.auth.tokenId } : {}),
        ...(input.auth?.tokenPrefix
          ? { tokenPrefix: input.auth.tokenPrefix }
          : {}),
        ...(input.authorization
          ? { repository: input.authorization.repository }
          : {}),
        ...(input.reviewId ? { reviewId: input.reviewId } : {}),
        ...(input.requestId ? { requestId: input.requestId } : {}),
        createdAt: nowMs(),
      });
    } catch (error) {
      logError(logger, '[review-service] auth audit write failed', error);
      throw new AuthAuditWriteError('authorization audit unavailable');
    }
  }

  async function appendAuthAuditOrUnavailable(
    context: Context,
    input: Parameters<typeof appendAuthAudit>[0]
  ): Promise<Response | null> {
    try {
      await appendAuthAudit(input);
      return null;
    } catch (error) {
      if (error instanceof AuthAuditWriteError) {
        return jsonError(context, 'authorization unavailable', 502);
      }
      throw error;
    }
  }

  async function authorizeStartRequest(
    context: Context,
    parsed: ReturnType<typeof ReviewStartRequestSchema.parse>,
    request: ReviewRequest
  ): Promise<ReviewRunAuthorization | Response | undefined> {
    const auth = getReviewAuthContext(context);
    if (!auth) {
      return undefined;
    }
    const soleRepository =
      auth.repositories.length === 1 ? auth.repositories[0] : undefined;
    const selection =
      parsed.repository ??
      (soleRepository
        ? repositorySelectionFromAuthorization(soleRepository)
        : undefined);
    if (!selection) {
      const auditUnavailable = await appendAuthAuditOrUnavailable(context, {
        operation: 'review:start',
        result: 'denied',
        reason: 'repository_required',
        status: 403,
        auth,
      });
      if (auditUnavailable) {
        return auditUnavailable;
      }
      return jsonError(context, 'repository authorization required', 403);
    }

    try {
      const repository = await authorizeRepositoryForRequest(
        auth,
        selection,
        'review:start'
      );
      try {
        assertCwdMatchesAuthorizedRepository(request, repository, config);
      } catch (error) {
        const auditUnavailable = await appendAuthAuditOrUnavailable(context, {
          operation: 'review:start',
          result: 'denied',
          reason: 'cwd_repository_mismatch',
          status: 403,
          auth,
        });
        if (auditUnavailable) {
          return auditUnavailable;
        }
        return jsonError(context, redactErrorMessage(error), 403);
      }
      const authorization: ReviewRunAuthorization = {
        principal: auth.principal,
        repository,
        scopes: auth.scopes,
        actor: actorForAuth(auth),
        requestHash: reviewRequestHash(request),
        authorizedAt: nowMs(),
      };
      const auditUnavailable = await appendAuthAuditOrUnavailable(context, {
        operation: 'review:start',
        result: 'allowed',
        reason: 'repository_scope_allowed',
        status: 200,
        auth,
        authorization,
      });
      if (auditUnavailable) {
        return auditUnavailable;
      }
      return authorization;
    } catch (error) {
      if (!isAuthHttpError(error)) {
        const auditUnavailable = await appendAuthAuditOrUnavailable(context, {
          operation: 'review:start',
          result: 'denied',
          reason: 'authorization_unavailable',
          status: 502,
          auth,
        });
        if (auditUnavailable) {
          return auditUnavailable;
        }
        return jsonError(context, 'authorization unavailable', 502);
      }
      const status = isAuthHttpError(error) ? error.status : 403;
      const auditUnavailable = await appendAuthAuditOrUnavailable(context, {
        operation: 'review:start',
        result: 'denied',
        reason: isAuthHttpError(error) ? error.reason : 'authorization_error',
        status,
        auth,
      });
      if (auditUnavailable) {
        return auditUnavailable;
      }
      return isAuthHttpError(error)
        ? authHttpErrorResponse(error)
        : jsonError(context, 'authorization denied', 403);
    }
  }

  async function authorizeRecordAccess(
    context: Context,
    record: ReviewRecord,
    operation: ReviewServiceAuthOperation,
    options: {
      auditAllowed?: boolean;
      forceDynamicAuthorization?: boolean;
    } = {}
  ): Promise<Response | null> {
    const auth = getReviewAuthContext(context);
    if (!auth) {
      return null;
    }
    if (!record.authorization) {
      const auditUnavailable = await appendAuthAuditOrUnavailable(context, {
        operation,
        result: 'denied',
        reason: 'run_has_no_authorization',
        status: 404,
        auth,
        reviewId: record.reviewId,
      });
      if (auditUnavailable) {
        return auditUnavailable;
      }
      return jsonError(context, 'review not found', 404);
    }

    try {
      await authorizeRepositoryForRequest(
        auth,
        record.authorization.repository,
        scopeForOperation(operation),
        { forceDynamic: options.forceDynamicAuthorization ?? false }
      );
      if (options.auditAllowed === false) {
        return null;
      }
      const auditUnavailable = await appendAuthAuditOrUnavailable(context, {
        operation,
        result: 'allowed',
        reason: 'run_repository_scope_allowed',
        status: 200,
        auth,
        authorization: record.authorization,
        reviewId: record.reviewId,
        requestId: record.authorization.requestHash,
      });
      if (auditUnavailable) {
        return auditUnavailable;
      }
      return null;
    } catch (error) {
      if (!isAuthHttpError(error)) {
        const auditUnavailable = await appendAuthAuditOrUnavailable(context, {
          operation,
          result: 'denied',
          reason: 'authorization_unavailable',
          status: 502,
          auth,
          authorization: record.authorization,
          reviewId: record.reviewId,
          requestId: record.authorization.requestHash,
        });
        if (auditUnavailable) {
          return auditUnavailable;
        }
        return jsonError(context, 'authorization unavailable', 502);
      }
      const reason = error.reason;
      const status =
        error.status === 401
          ? 401
          : reason === 'scope_missing' || reason === 'github_permission_missing'
            ? 403
            : 404;
      const auditUnavailable = await appendAuthAuditOrUnavailable(context, {
        operation,
        result: 'denied',
        reason,
        status,
        auth,
        authorization: record.authorization,
        reviewId: record.reviewId,
        requestId: record.authorization.requestHash,
      });
      if (auditUnavailable) {
        return auditUnavailable;
      }
      if (status === 401) {
        return authHttpErrorResponse(error);
      }
      return jsonError(
        context,
        status === 403 ? 'authorization denied' : 'review not found',
        status
      );
    }
  }

  async function revalidateServiceTokenForStream(
    context: Context,
    auth: ReviewAuthenticatedRequest,
    record: ReviewRecord
  ): Promise<Response | null> {
    if (auth.principal.type !== 'serviceToken' || !authStore) {
      return null;
    }

    let tokenRecord: Awaited<ReturnType<typeof authStore.getServiceToken>>;
    try {
      tokenRecord = await authStore.getServiceToken(auth.principal.tokenId);
    } catch {
      return jsonError(context, 'authorization unavailable', 502);
    }

    const denyStreamToken = async (reason: string): Promise<Response> => {
      const auditUnavailable = await appendAuthAuditOrUnavailable(context, {
        operation: 'review:read',
        result: 'denied',
        reason,
        status: 401,
        auth,
        reviewId: record.reviewId,
        ...(record.authorization
          ? {
              authorization: record.authorization,
              requestId: record.authorization.requestHash,
            }
          : {}),
      });
      if (auditUnavailable) {
        return auditUnavailable;
      }
      return authHttpErrorResponse(new AuthHttpError(401, reason));
    };

    if (!tokenRecord) {
      return denyStreamToken('service_token_unknown');
    }
    if (auth.tokenHash && tokenRecord.tokenHash !== auth.tokenHash) {
      return denyStreamToken('service_token_invalid');
    }
    if (tokenRecord.revokedAt !== undefined) {
      return denyStreamToken('service_token_revoked');
    }
    if (
      tokenRecord.expiresAt !== undefined &&
      tokenRecord.expiresAt <= nowMs()
    ) {
      return denyStreamToken('service_token_expired');
    }

    auth.scopes = tokenRecord.scopes;
    auth.repositories = [tokenRecord.repository];
    auth.tokenId = tokenRecord.tokenId;
    auth.tokenPrefix = tokenRecord.tokenPrefix;
    auth.tokenHash = tokenRecord.tokenHash;
    auth.principal = {
      type: 'serviceToken',
      tokenId: tokenRecord.tokenId,
      tokenPrefix: tokenRecord.tokenPrefix,
      name: tokenRecord.name,
    };
    return null;
  }

  async function revalidateStreamAccess(
    context: Context,
    record: ReviewRecord,
    options: { lastGitHubDynamicAuthorizationAt?: number } = {}
  ): Promise<Response | null> {
    const auth = getReviewAuthContext(context);
    if (!auth) {
      return null;
    }
    const tokenDenied = await revalidateServiceTokenForStream(
      context,
      auth,
      record
    );
    if (tokenDenied) {
      return tokenDenied;
    }
    const shouldForceDynamicAuthorization =
      auth.principal.type === 'githubUser' &&
      (options.lastGitHubDynamicAuthorizationAt === undefined ||
        nowMs() - options.lastGitHubDynamicAuthorizationAt >=
          config.githubStreamAuthorizationTtlMs);
    const accessDenied = await authorizeRecordAccess(
      context,
      record,
      'review:read',
      {
        auditAllowed: false,
        forceDynamicAuthorization: shouldForceDynamicAuthorization,
      }
    );
    if (!accessDenied && shouldForceDynamicAuthorization) {
      options.lastGitHubDynamicAuthorizationAt = nowMs();
    }
    return accessDenied;
  }

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
    releaseRuntimeLease(record);
    record.retentionExpiresAt = record.updatedAt + config.maxRecordAgeMs;
  }

  function attachRuntimeLease(record: ReviewRecord, scopeKey: string): void {
    const now = nowMs();
    record.lease = {
      owner: RUNTIME_LEASE_OWNER,
      scopeKey,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: now + config.runtimeLeaseTtlMs,
    };
  }

  function assertRuntimeLeaseAttached(
    record: ReviewRecord
  ): asserts record is ReviewRecord & {
    lease: NonNullable<ReviewRecord['lease']>;
  } {
    if (!record.lease) {
      throw new Error('runtime reservation requires a lease');
    }
  }

  function heartbeatRuntimeLease(record: ReviewRecord): void {
    if (!record.lease || isTerminalReviewRunStatus(record.status)) {
      return;
    }
    const now = nowMs();
    record.lease = {
      ...record.lease,
      heartbeatAt: now,
      expiresAt: now + config.runtimeLeaseTtlMs,
    };
  }

  function releaseRuntimeLease(record: ReviewRecord): void {
    if ('lease' in record) {
      delete record.lease;
    }
  }

  function runtimeLeaseExpired(record: ReviewRecord, now: number): boolean {
    return (
      !isTerminalReviewRunStatus(record.status) &&
      record.lease !== undefined &&
      record.lease.expiresAt <= now
    );
  }

  async function failRuntimeLease(record: ReviewRecord): Promise<void> {
    record.status = 'failed';
    record.error = 'runtime lease expired';
    record.updatedAt = nowMs();
    setTerminalRetention(record);
    await emit(record, { type: 'failed', message: record.error });
    await store.set(record, { reason: 'runtime lease expired' });
  }

  async function failExpiredRuntimeLease(
    record: ReviewRecord
  ): Promise<boolean> {
    if (!runtimeLeaseExpired(record, nowMs())) {
      return false;
    }
    await failRuntimeLease(record);
    return true;
  }

  async function failMissingDetachedRun(record: ReviewRecord): Promise<void> {
    record.status = 'failed';
    record.error = 'detached run not found';
    record.updatedAt = nowMs();
    setTerminalRetention(record);
    await emit(record, { type: 'failed', message: record.error });
    await store.set(record, { reason: 'detached run missing' });
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
        ...(record.sandboxId ? { sandboxId: record.sandboxId } : {}),
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
      logError(logger, `[review-service] ${failureMessage}`, error);
      return jsonError(context, failureMessage, 502);
    }
  }

  if (config.recordCleanupIntervalMs !== false) {
    const cleanupInterval = setInterval(() => {
      cleanupReviewRecords().catch((error) => {
        logError(logger, '[review-service] cleanup failed', error);
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
                ...((record.sandboxId ?? event.meta.correlation.sandboxId)
                  ? {
                      sandboxId:
                        record.sandboxId ?? event.meta.correlation.sandboxId,
                    }
                  : {}),
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
                ...(record.sandboxId ? { sandboxId: record.sandboxId } : {}),
                ...(correlationOverride ?? {}),
              },
            },
          };

    const sanitized = redactLifecycleEvent(enriched);

    await store.appendEvent(record, sanitized, {
      maxEvents: config.maxRecordEvents,
      reason: 'lifecycle event',
    });

    const listeners = liveListeners.get(record.reviewId);
    if (!listeners) {
      return enriched;
    }

    for (const listener of [...listeners]) {
      try {
        const result = listener(sanitized);
        if (result instanceof Promise) {
          result.catch(() => {
            logError(
              logger,
              `[review-service] dropping failed lifecycle listener for ${record.reviewId}:`,
              'listener promise rejected'
            );
            removeLiveListener(record.reviewId, listener);
          });
        }
      } catch (error) {
        logError(
          logger,
          `[review-service] dropping failed lifecycle listener for ${record.reviewId}:`,
          error
        );
        removeLiveListener(record.reviewId, listener);
      }
    }
    return sanitized;
  }

  async function runInline(
    record: ReviewRecord,
    request: ReviewRequest,
    signal?: AbortSignal
  ): Promise<void> {
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatStopped = false;
    const stopInlineHeartbeat = () => {
      heartbeatStopped = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    };
    const persistInlineHeartbeat = async (): Promise<void> => {
      if (heartbeatStopped || isTerminalReviewRunStatus(record.status)) {
        return;
      }
      heartbeatRuntimeLease(record);
      await store.set(record, { reason: 'inline heartbeat' });
    };
    const startInlineHeartbeat = () => {
      const heartbeatIntervalMs = Math.max(
        100,
        Math.min(Math.floor(config.runtimeLeaseTtlMs / 2), 30_000)
      );
      heartbeatTimer = setInterval(() => {
        void persistInlineHeartbeat().catch((error) => {
          logError(logger, '[review-service] inline heartbeat failed', error);
        });
      }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    };

    try {
      record.status = 'running';
      record.updatedAt = nowMs();
      heartbeatRuntimeLease(record);
      await emit(record, {
        type: 'progress',
        message: 'starting inline review run',
      });
      await store.set(record, { reason: 'inline running' });

      if (request.executionMode === 'remoteSandbox') {
        throw new Error(config.remoteSandboxInlineError);
      }

      startInlineHeartbeat();
      const review = await runner(
        request,
        {
          providers: dependencies.providers,
          onEvent: async (event) => {
            await persistInlineHeartbeat();
            await emit(record, event);
          },
          now: () => new Date(nowMs()),
          correlation: {
            workflowRunId: record.workflowRunId ?? record.detachedRunId,
          },
          limits: config.reviewLimits,
          ...(signal ? { signal } : {}),
        },
        dependencies.bridge
      );
      stopInlineHeartbeat();
      record.result = redactReviewRunResult(review);
      record.status = 'completed';
      record.updatedAt = nowMs();
      setTerminalRetention(record);
      await store.set(record, { reason: 'inline completed' });
    } catch (error) {
      stopInlineHeartbeat();
      const cancelled = error instanceof ReviewRunCancelledError;
      record.status = cancelled ? 'cancelled' : 'failed';
      record.error = redactErrorMessage(
        error,
        cancelled ? 'review run cancelled' : 'review run failed'
      );
      record.updatedAt = nowMs();
      setTerminalRetention(record);
      await emit(
        record,
        cancelled
          ? { type: 'cancelled' }
          : { type: 'failed', message: record.error }
      );
      await store.set(record, {
        reason: cancelled ? 'inline cancelled' : 'inline failed',
      });
    } finally {
      stopInlineHeartbeat();
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
      await failMissingDetachedRun(record);
      return;
    }

    if (
      !isTerminalReviewRunStatus(detached.status) &&
      runtimeLeaseExpired(record, nowMs())
    ) {
      const cancellationAccepted = await dependencies.worker.cancel(
        record.detachedRunId
      );
      if (cancellationAccepted) {
        record.cancelRequestedAt = nowMs();
        record.updatedAt = nowMs();
        heartbeatRuntimeLease(record);
        await store.set(record, {
          reason: 'runtime lease expired cancellation requested',
        });
      } else {
        await failRuntimeLease(record);
      }
      return;
    }

    const previousStatus = record.status;
    const previousError = record.error;
    const previousWorkflowRunId = record.workflowRunId;
    const previousSandboxId = record.sandboxId;
    const previousLeaseHeartbeatAt = record.lease?.heartbeatAt;
    const previousLeaseExpiresAt = record.lease?.expiresAt;
    let changed = false;

    record.workflowRunId = detached.workflowRunId ?? detached.runId;
    heartbeatRuntimeLease(record);
    if (
      record.lease?.heartbeatAt !== previousLeaseHeartbeatAt ||
      record.lease?.expiresAt !== previousLeaseExpiresAt
    ) {
      changed = true;
    }
    const detachedSandboxId =
      detached.sandboxId ?? detached.result?.sandboxAudit?.sandboxId;
    if (detachedSandboxId) {
      record.sandboxId = detachedSandboxId;
    }
    record.status = detached.status;
    if (record.workflowRunId !== previousWorkflowRunId) {
      changed = true;
    }
    if (record.sandboxId !== previousSandboxId) {
      changed = true;
    }
    if (detached.status === 'completed' && detached.result) {
      record.result = redactReviewRunResult(detached.result);
      changed = true;
    }
    if (detached.status === 'failed') {
      record.error = redactErrorMessage(
        detached.error ?? 'detached run failed',
        'detached run failed'
      );
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
    if (!changed) {
      await failExpiredRuntimeLease(record);
    }
  }

  async function authenticateRequestContext(
    context: Context
  ): Promise<Response | null> {
    if (authMode === 'disabled') {
      return null;
    }
    if (!authPolicy) {
      return authRequiredResponse(context);
    }
    const authResult = await authPolicy(context);
    if (authResult instanceof Response) {
      return authResult;
    }
    if (!authResult) {
      return authRequiredResponse(context);
    }
    setReviewAuthContext(context, authResult);
    return null;
  }

  app.use('/v1/*', async (context, next) => {
    const denied = await authenticateRequestContext(context);
    if (denied) {
      return denied;
    }
    await next();
  });

  app.post(
    '/v1/review/start',
    bodyLimit({
      maxSize: config.maxRequestBodyBytes,
      onError: (context) =>
        jsonError(
          context,
          'review start request body exceeds configured byte limit',
          413
        ),
    }),
    async (context) => {
      let parsed: ReturnType<typeof ReviewStartRequestSchema.parse>;
      try {
        parsed = await parseJsonBody(context, (body) =>
          ReviewStartRequestSchema.parse(body)
        );
      } catch {
        return jsonError(context, 'invalid review start request', 400);
      }

      try {
        const { delivery } = parsed;
        const request = prepareReviewRequestForService(parsed.request, config);
        const authorization = await authorizeStartRequest(
          context,
          parsed,
          request
        );
        if (authorization instanceof Response) {
          return authorization;
        }
        if (
          request.executionMode === 'remoteSandbox' &&
          delivery !== 'detached' &&
          !request.detached
        ) {
          return jsonError(context, config.remoteSandboxInlineError, 400);
        }
        if (
          request.executionMode === 'remoteSandbox' &&
          request.target.type !== 'custom'
        ) {
          return jsonError(
            context,
            `${REMOTE_SANDBOX_UNSUPPORTED_TARGET_ERROR}; received target "${request.target.type}"`,
            400
          );
        }

        const reviewId = uuid();
        const record = createReviewRecord(
          redactReviewRequest(request),
          reviewId,
          nowMs(),
          authorization
        );
        attachRuntimeLease(record, runtimeScopeKeyForRequest(request));
        assertRuntimeLeaseAttached(record);
        await cleanupReviewRecords();
        const reservation = await store.reserve(record, {
          nowMs: nowMs(),
          legacyUnleasedActiveTtlMs: config.maxRecordAgeMs,
          scopeKeyForRequest: runtimeScopeKeyForRequest,
          maxQueuedRuns: config.maxQueuedRuns,
          maxRunningRuns: config.maxRunningRuns,
          maxActiveRunsPerScope: config.maxActiveRunsPerScope,
          reason: 'runtime reserved',
        });
        if (!reservation.reserved) {
          throw new RuntimeBackpressureError(reservation.message);
        }

        if (delivery === 'detached' || request.detached) {
          let detached: DetachedRunRecord;
          try {
            detached = await dependencies.worker.startDetached(request);
          } catch (error) {
            record.status = 'failed';
            record.error = redactErrorMessage(error, 'detached start failed');
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
          const detachedSandboxId =
            detached.sandboxId ?? detached.result?.sandboxAudit?.sandboxId;
          if (detachedSandboxId) {
            record.sandboxId = detachedSandboxId;
          }
          record.status = detached.status;
          if (detached.result) {
            record.result = redactReviewRunResult(detached.result);
          }
          if (detached.error) {
            record.error = redactErrorMessage(detached.error);
          }
          record.updatedAt = nowMs();
          heartbeatRuntimeLease(record);
          if (isTerminalReviewRunStatus(record.status)) {
            setTerminalRetention(record);
          }
          await emit(record, {
            type: 'enteredReviewMode',
            review: 'review requested',
          });
          if (isTerminalReviewRunStatus(record.status)) {
            await emitDetachedTerminalEvents(record);
          }
          await store.set(record, { reason: 'detached started' });
          const response: ReviewStartResponse = {
            reviewId,
            status: record.status,
            detachedRunId: detached.runId,
          };
          return context.json(response, 202);
        }

        await runInline(record, request, context.req.raw.signal);
        const response: ReviewStartResponse = {
          reviewId,
          status: record.status,
          ...(record.result
            ? { result: redactReviewResult(record.result.result).result }
            : {}),
        };
        return context.json(response, 200);
      } catch (error) {
        if (error instanceof ReviewRequestPolicyError) {
          return jsonError(context, redactErrorMessage(error), 400);
        }
        if (error instanceof RuntimeBackpressureError) {
          return jsonError(context, error.message, 429, {
            'Retry-After': '1',
          });
        }
        logError(logger, '[review-service] failed to start review', error);
        return jsonError(context, 'failed to start review', 502);
      }
    }
  );

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
    const denied = await authorizeRecordAccess(context, record, 'review:read');
    if (denied) {
      return denied;
    }

    try {
      await syncDetachedRecord(record);
      await failExpiredRuntimeLease(record);
      return context.json(buildStatusResponse(record));
    } catch (error) {
      logError(logger, '[review-service] failed to fetch run status', error);
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
    const denied = await authorizeRecordAccess(context, record, 'review:read');
    if (denied) {
      return denied;
    }

    let cursor: ReviewEventCursor;
    try {
      cursor = parseEventCursor(context, reviewId);
    } catch {
      return jsonError(context, 'invalid event cursor', 400);
    }

    try {
      await syncDetachedRecord(record);
      await failExpiredRuntimeLease(record);
    } catch (error) {
      logError(
        logger,
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
      const streamAuthState: { lastGitHubDynamicAuthorizationAt?: number } = {};
      if (getReviewAuthContext(context)?.principal.type === 'githubUser') {
        streamAuthState.lastGitHubDynamicAuthorizationAt = nowMs();
      }

      const cleanup = () => {
        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        streaming = false;
        removeLiveListener(record.reviewId, send);
        void stream.close();
      };

      const enqueueSseOperation = (
        operation: () => Promise<void>
      ): Promise<void> => {
        const queued = writeQueue.then(async () => {
          if (!streaming) {
            return;
          }
          await operation();
        });
        writeQueue = queued.catch((error) => {
          logError(logger, '[review-service] events stream error', error);
          cleanup();
        });
        return writeQueue;
      };

      const writeQueuedSse = (
        frame: Parameters<typeof stream.writeSSE>[0]
      ): Promise<void> => {
        return enqueueSseOperation(() => stream.writeSSE(frame));
      };

      const send: ReviewLifecycleListener = (event) => {
        return enqueueSseOperation(async () => {
          if (deliveredEventIds.has(event.meta.eventId)) {
            return;
          }
          const latestRecord = await store.get(record.reviewId);
          if (!latestRecord) {
            cleanup();
            return;
          }
          const accessDenied = await revalidateStreamAccess(
            context,
            latestRecord,
            streamAuthState
          );
          if (accessDenied) {
            cleanup();
            return;
          }
          deliveredEventIds.add(event.meta.eventId);
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
            id: event.meta.eventId,
            retry: 1000,
          });
        });
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
        logError(logger, '[review-service] events stream error', error);
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
          const accessDenied = await revalidateStreamAccess(
            context,
            latestRecord,
            streamAuthState
          );
          if (accessDenied) {
            cleanup();
            break;
          }
          await syncDetachedRecord(latestRecord);
          await failExpiredRuntimeLease(latestRecord);
          if (!streaming) {
            break;
          }
          await writeQueuedSse({
            event: 'keepalive',
            data: '',
          });
        }
      } catch (error) {
        logError(logger, '[review-service] events stream error', error);
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
    const denied = await authorizeRecordAccess(context, record, 'review:read');
    if (denied) {
      return denied;
    }

    try {
      await syncDetachedRecord(record);
      await failExpiredRuntimeLease(record);
    } catch (error) {
      logError(
        logger,
        '[review-service] failed to sync artifact status',
        error
      );
      return jsonError(context, 'failed to fetch artifact status', 502);
    }

    if (!record.result) {
      return jsonError(context, 'artifact not ready', 404);
    }

    const formatRaw = context.req.param('format');
    const formatResult = OutputFormatSchema.safeParse(formatRaw);
    if (!formatResult.success) {
      return jsonError(context, 'invalid artifact format', 400);
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
    const denied = await authorizeRecordAccess(
      context,
      record,
      'review:cancel'
    );
    if (denied) {
      return denied;
    }

    if (record.detachedRunId) {
      try {
        await syncDetachedRecord(record);
        if (await failExpiredRuntimeLease(record)) {
          const response: ReviewCancelResponse = {
            reviewId,
            status: record.status,
            cancelled: false,
          };
          return context.json(response, 409);
        }
        if (isTerminalReviewRunStatus(record.status)) {
          const response: ReviewCancelResponse = {
            reviewId,
            status: record.status,
            cancelled: false,
          };
          return context.json(response, 409);
        }
        if (record.cancelRequestedAt !== undefined) {
          const response: ReviewCancelResponse = {
            reviewId,
            status: record.status,
            cancelled: false,
          };
          return context.json(response, 202);
        }
        const cancelled = await dependencies.worker.cancel(
          record.detachedRunId
        );
        if (cancelled) {
          record.cancelRequestedAt = nowMs();
          heartbeatRuntimeLease(record);
          await store.set(record, { reason: 'cancel requested' });
          await syncDetachedRecord(record);
          if (record.status === 'cancelled') {
            await cleanupReviewRecords();
            const response: ReviewCancelResponse = {
              reviewId,
              status: record.status,
            };
            return context.json(response);
          }
          if (isTerminalReviewRunStatus(record.status)) {
            const response: ReviewCancelResponse = {
              reviewId,
              status: record.status,
              cancelled: false,
            };
            return context.json(response, 409);
          }
          const response: ReviewCancelResponse = {
            reviewId,
            status: record.status,
            cancelled: false,
          };
          return context.json(response, 202);
        }
        await syncDetachedRecord(record);
      } catch (error) {
        logError(logger, '[review-service] failed to cancel run', error);
        return jsonError(context, 'failed to cancel run', 502);
      }
    }

    if (isTerminalReviewRunStatus(record.status)) {
      const response: ReviewCancelResponse = {
        reviewId,
        status: record.status,
        cancelled: false,
      };
      return context.json(response, 409);
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
