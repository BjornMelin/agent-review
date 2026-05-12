import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  createAppAuth,
  type InstallationAccessTokenAuthentication,
  type InstallationAuthOptions,
} from '@octokit/auth-app';
import { request as octokitRequest } from '@octokit/request';
import type {
  ReviewAuthPrincipal,
  ReviewAuthScope,
  ReviewRepositoryAuthorization,
  ReviewRepositorySelection,
} from '@review-agent/review-types';
import type { Context } from 'hono';
import type {
  AuthAuditEventRecord,
  ReviewAuthStoreAdapter,
  ServiceTokenRecord,
} from './storage/index.js';

/**
 * Prefixes scoped review-service automation bearer tokens.
 */
export const REVIEW_SERVICE_TOKEN_PREFIX = 'rat';

const DEFAULT_GITHUB_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
const DEFAULT_GITHUB_API_VERSION = '2026-03-10';

/**
 * Lists hosted review operations that can be authorized by scopes.
 */
export type ReviewServiceAuthOperation =
  | 'review:start'
  | 'review:read'
  | 'review:cancel'
  | 'review:publish';

/**
 * Carries the authenticated principal and repository grants for one request.
 */
export type ReviewAuthenticatedRequest = {
  principal: ReviewAuthPrincipal;
  scopes: ReviewAuthScope[];
  repositories: ReviewRepositoryAuthorization[];
  tokenId?: string;
  tokenPrefix?: string;
  tokenHash?: string;
  authorizeRepository?: (
    selection: ReviewRepositorySelection,
    scope: ReviewAuthScope
  ) => Promise<
    | {
        principal: ReviewAuthPrincipal;
        repository: ReviewRepositoryAuthorization;
        scopes?: ReviewAuthScope[];
      }
    | undefined
  >;
};

/**
 * Represents an auth policy decision before hosted routes execute.
 */
export type ReviewServiceAuthPolicyResult =
  | ReviewAuthenticatedRequest
  | Response
  | null;

/**
 * Evaluates a Hono request and returns auth context or an auth response.
 */
export type ReviewServiceAuthPolicy = (
  context: Context
) => ReviewServiceAuthPolicyResult | Promise<ReviewServiceAuthPolicyResult>;

/**
 * Contains the one-time raw service token and its durable hashed record.
 */
export type ServiceTokenCredential = {
  token: string;
  record: ServiceTokenRecord;
};

/**
 * Verifies GitHub user bearer tokens and repository-scoped permissions.
 */
export type GitHubUserTokenAuthorizer = {
  authenticateUserToken(
    token: string
  ): Promise<Extract<ReviewAuthPrincipal, { type: 'githubUser' }>>;
  authorizeUserToken(
    token: string,
    selection: ReviewRepositorySelection,
    scope: ReviewAuthScope
  ): Promise<{
    principal: Extract<ReviewAuthPrincipal, { type: 'githubUser' }>;
    repository: ReviewRepositoryAuthorization;
    scopes?: ReviewAuthScope[];
  }>;
};

/**
 * Requests a GitHub App installation token narrowed to repositories.
 */
export type GitHubInstallationTokenRequest = {
  installationId: number;
  repositoryIds: [number, ...number[]];
  permissions?: Record<string, 'read' | 'write'>;
};

/**
 * Describes a minted GitHub App installation access token.
 */
export type GitHubInstallationToken = {
  token: string;
  expiresAt: number;
  permissions: Record<string, string>;
  repositorySelection?: string;
};

/**
 * Signals an authenticated request that failed with an HTTP auth status.
 */
export class AuthHttpError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly reason: string
  ) {
    super(reason);
    this.name = 'AuthHttpError';
  }
}

class AuthDependencyError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'AuthDependencyError';
  }
}

function authHttpErrorFromUnknown(error: unknown): AuthHttpError | undefined {
  if (error instanceof AuthHttpError) {
    return error;
  }
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  if (status === 401) {
    return new AuthHttpError(401, 'github_token_invalid');
  }
  if (status === 404) {
    return new AuthHttpError(403, 'github_repository_not_accessible');
  }
  const message =
    'message' in error && typeof error.message === 'string'
      ? error.message.toLowerCase()
      : '';
  const headers =
    'response' in error &&
    error.response &&
    typeof error.response === 'object' &&
    'headers' in error.response &&
    error.response.headers &&
    typeof error.response.headers === 'object'
      ? (error.response.headers as Record<string, unknown>)
      : {};
  const rateLimited =
    status === 429 ||
    (status === 403 &&
      (message.includes('rate limit') ||
        headers['x-ratelimit-remaining'] === '0'));
  if (status === 403 && !rateLimited) {
    return new AuthHttpError(403, 'github_access_denied');
  }
  return undefined;
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function jsonAuthError(message: string, status: 401 | 403): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}),
    },
  });
}

function jsonAuthDependencyError(): Response {
  return new Response(JSON.stringify({ error: 'authentication unavailable' }), {
    status: 502,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function bearerToken(context: Context): string | undefined {
  const header = context.req.header('authorization');
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function parseServiceTokenId(token: string): string | undefined {
  const match = token.match(/^rat_([A-Za-z0-9-]{6,})_[A-Za-z0-9_-]{20,}$/);
  if (!match) {
    return undefined;
  }
  return match[1];
}

function hashServiceToken(token: string, pepper: string): string {
  return createHmac('sha256', pepper).update(token).digest('hex');
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function sameRepository(
  left: ReviewRepositoryAuthorization,
  right: ReviewRepositorySelection | ReviewRepositoryAuthorization
): boolean {
  if ('repositoryId' in right && right.repositoryId !== undefined) {
    return left.repositoryId === right.repositoryId;
  }
  if (right.installationId !== undefined) {
    return (
      left.installationId === right.installationId &&
      left.owner.toLowerCase() === right.owner.toLowerCase() &&
      left.name.toLowerCase() === right.name.toLowerCase()
    );
  }
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase()
  );
}

function isPublicGitHubApiBaseUrl(baseUrl: string): boolean {
  return (
    baseUrl.replace(/\/+$/, '').toLowerCase() === DEFAULT_GITHUB_API_BASE_URL
  );
}

function scopeAllowed(
  requested: ReviewAuthScope,
  granted: ReviewAuthScope[]
): boolean {
  return granted.includes(requested);
}

async function audit(
  store: ReviewAuthStoreAdapter,
  input: Omit<AuthAuditEventRecord, 'auditEventId' | 'createdAt'>
): Promise<void> {
  try {
    await store.appendAuthAuditEvent({
      auditEventId: randomUUID(),
      createdAt: Date.now(),
      ...input,
    });
  } catch (error) {
    throw new AuthDependencyError(
      error instanceof Error ? error.message : 'auth audit store unavailable'
    );
  }
}

/**
 * Generates a high-entropy scoped service token and its hashed store record.
 *
 * @param input - Token metadata, repository authorization, scopes, and hash pepper.
 * @returns Raw token shown once plus the durable record containing only its verifier hash.
 * @throws Error - When token ID or secret overrides are not URL-safe or long enough.
 */
export function createServiceTokenCredential(input: {
  name: string;
  scopes: ReviewAuthScope[];
  repository: ReviewRepositoryAuthorization;
  pepper: string;
  tokenId?: string;
  secret?: string;
  nowMs?: number;
  expiresAt?: number;
  createdBy?: ReviewAuthPrincipal;
}): ServiceTokenCredential {
  const nowMs = input.nowMs ?? Date.now();
  const tokenId = input.tokenId ?? randomBytes(12).toString('hex');
  const secret = input.secret ?? base64Url(randomBytes(32));
  if (!/^[A-Za-z0-9-]{6,}$/.test(tokenId)) {
    throw new Error(
      'service token id must be at least 6 URL-safe chars and must not contain separators'
    );
  }
  if (!/^[A-Za-z0-9_-]{20,}$/.test(secret)) {
    throw new Error('service token secret must be at least 20 URL-safe chars');
  }
  const token = `${REVIEW_SERVICE_TOKEN_PREFIX}_${tokenId}_${secret}`;
  return {
    token,
    record: {
      tokenId,
      tokenPrefix: `${REVIEW_SERVICE_TOKEN_PREFIX}_${tokenId}`,
      tokenHash: hashServiceToken(token, input.pepper),
      name: input.name,
      scopes: input.scopes,
      repository: input.repository,
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      createdAt: nowMs,
      updatedAt: nowMs,
    },
  };
}

/**
 * Creates a hosted service auth policy for scoped service tokens and GitHub user tokens.
 *
 * @param options - Auth store, token hash pepper, and optional GitHub user-token verifier.
 * @returns A Hono-compatible auth policy for `createReviewServiceApp`.
 * @throws Error - When an unexpected non-auth dependency error escapes token verification.
 */
export function createReviewServiceAuthPolicy(options: {
  store: ReviewAuthStoreAdapter;
  serviceTokenPepper: string;
  githubUserTokenAuthorizer?: GitHubUserTokenAuthorizer;
}): ReviewServiceAuthPolicy {
  return async (context) => {
    try {
      const token = bearerToken(context);
      if (!token) {
        await audit(options.store, {
          eventType: 'authn',
          operation: 'request',
          result: 'denied',
          reason: 'missing_bearer_token',
          status: 401,
        });
        return jsonAuthError('authentication required', 401);
      }

      const serviceTokenId = parseServiceTokenId(token);
      if (serviceTokenId) {
        try {
          const record = await options.store.getServiceToken(serviceTokenId);
          if (!record) {
            throw new AuthHttpError(401, 'service_token_unknown');
          }
          const actualHash = hashServiceToken(
            token,
            options.serviceTokenPepper
          );
          if (!constantTimeEqual(actualHash, record.tokenHash)) {
            throw new AuthHttpError(401, 'service_token_invalid');
          }
          const nowMs = Date.now();
          if (record.revokedAt !== undefined) {
            throw new AuthHttpError(401, 'service_token_revoked');
          }
          if (record.expiresAt !== undefined && record.expiresAt <= nowMs) {
            throw new AuthHttpError(401, 'service_token_expired');
          }
          await options.store.touchServiceToken(record.tokenId, nowMs);
          await audit(options.store, {
            eventType: 'token',
            operation: 'request',
            result: 'allowed',
            reason: 'service_token_verified',
            status: 200,
            principal: {
              type: 'serviceToken',
              tokenId: record.tokenId,
              tokenPrefix: record.tokenPrefix,
              name: record.name,
            },
            tokenId: record.tokenId,
            tokenPrefix: record.tokenPrefix,
            repository: record.repository,
          });
          return {
            principal: {
              type: 'serviceToken',
              tokenId: record.tokenId,
              tokenPrefix: record.tokenPrefix,
              name: record.name,
            },
            scopes: record.scopes,
            repositories: [record.repository],
            tokenId: record.tokenId,
            tokenPrefix: record.tokenPrefix,
            tokenHash: record.tokenHash,
          };
        } catch (error) {
          if (!(error instanceof AuthHttpError)) {
            await audit(options.store, {
              eventType: 'authn',
              operation: 'request',
              result: 'denied',
              reason: 'auth_store_unavailable',
              status: 502,
              tokenId: serviceTokenId,
              tokenPrefix: `${REVIEW_SERVICE_TOKEN_PREFIX}_${serviceTokenId}`,
            }).catch(() => undefined);
            return jsonAuthDependencyError();
          }
          const status = error.status;
          const reason = error.reason;
          await audit(options.store, {
            eventType: 'authn',
            operation: 'request',
            result: 'denied',
            reason,
            status,
            tokenId: serviceTokenId,
            tokenPrefix: `${REVIEW_SERVICE_TOKEN_PREFIX}_${serviceTokenId}`,
          });
          return jsonAuthError('invalid bearer token', status);
        }
      }

      if (!options.githubUserTokenAuthorizer) {
        await audit(options.store, {
          eventType: 'authn',
          operation: 'request',
          result: 'denied',
          reason: 'unsupported_bearer_token',
          status: 401,
        });
        return jsonAuthError('invalid bearer token', 401);
      }

      let principal: Extract<ReviewAuthPrincipal, { type: 'githubUser' }>;
      try {
        principal =
          await options.githubUserTokenAuthorizer.authenticateUserToken(token);
      } catch (error) {
        const authError = authHttpErrorFromUnknown(error);
        if (authError) {
          await audit(options.store, {
            eventType: 'authn',
            operation: 'request',
            result: 'denied',
            reason: authError.reason,
            status: authError.status,
          });
          return jsonAuthError(
            authError.status === 401
              ? 'invalid bearer token'
              : 'authorization denied',
            authError.status
          );
        }
        await audit(options.store, {
          eventType: 'authn',
          operation: 'request',
          result: 'denied',
          reason: 'github_auth_unavailable',
          status: 502,
        });
        return jsonAuthDependencyError();
      }
      await audit(options.store, {
        eventType: 'authn',
        operation: 'request',
        result: 'allowed',
        reason: 'github_user_token_verified',
        status: 200,
        principal,
      });

      return {
        principal,
        scopes: [],
        repositories: [],
        authorizeRepository: async (selection, scope) => {
          try {
            return await options.githubUserTokenAuthorizer?.authorizeUserToken(
              token,
              selection,
              scope
            );
          } catch (error) {
            const authError = authHttpErrorFromUnknown(error);
            if (authError) {
              throw authError;
            }
            throw error;
          }
        },
      };
    } catch (error) {
      if (error instanceof AuthDependencyError) {
        return jsonAuthDependencyError();
      }
      throw error;
    }
  };
}

/**
 * Resolves a repository authorization from an authenticated request.
 *
 * @param auth - Authenticated request context.
 * @param selection - Requested repository or stored run repository.
 * @param scope - Required operation scope.
 * @param options - Resolution behavior such as bypassing cached repository grants.
 * @returns Effective repository authorization.
 * @throws AuthHttpError when the principal lacks the requested scope or repository.
 */
export async function authorizeRepositoryForRequest(
  auth: ReviewAuthenticatedRequest,
  selection: ReviewRepositorySelection | ReviewRepositoryAuthorization,
  scope: ReviewAuthScope,
  options: { forceDynamic?: boolean } = {}
): Promise<ReviewRepositoryAuthorization> {
  const local = options.forceDynamic
    ? undefined
    : auth.repositories.find((repository) =>
        sameRepository(repository, selection)
      );
  if (local) {
    if (!scopeAllowed(scope, auth.scopes)) {
      throw new AuthHttpError(403, 'scope_missing');
    }
    return local;
  }
  const dynamicSelection =
    'visibility' in selection
      ? repositorySelectionFromAuthorization(selection)
      : selection;
  const resolved = await auth.authorizeRepository?.(dynamicSelection, scope);
  if (!resolved) {
    throw new AuthHttpError(403, 'repository_not_granted');
  }
  if (!sameRepository(resolved.repository, selection)) {
    throw new AuthHttpError(403, 'repository_not_granted');
  }
  const resolvedScopes = resolved.scopes ?? [scope];
  if (!scopeAllowed(scope, resolvedScopes)) {
    throw new AuthHttpError(403, 'scope_missing');
  }
  auth.principal = resolved.principal;
  auth.repositories = [resolved.repository];
  auth.scopes = [...new Set(resolvedScopes)];
  return resolved.repository;
}

/**
 * Determines whether an unknown error is a structured auth HTTP failure.
 *
 * @param error - Unknown error value to inspect.
 * @returns True when the error is an `AuthHttpError`.
 */
export function isAuthHttpError(error: unknown): error is AuthHttpError {
  return error instanceof AuthHttpError;
}

/**
 * Converts a structured auth failure into a JSON bearer-auth response.
 *
 * @param error - Auth HTTP failure to serialize.
 * @returns Response with the matching status and safe body.
 */
export function authHttpErrorResponse(error: AuthHttpError): Response {
  return jsonAuthError(
    error.status === 401 ? 'authentication required' : 'authorization denied',
    error.status
  );
}

function permissionScopes(
  permissions: Record<string, boolean>
): ReviewAuthScope[] {
  const canRead =
    permissions.pull ||
    permissions.triage ||
    permissions.maintain ||
    permissions.push ||
    permissions.admin;
  const canWrite =
    permissions.push || permissions.maintain || permissions.admin;
  return [
    ...(canRead ? (['review:start', 'review:read'] as const) : []),
    ...(canWrite ? (['review:cancel', 'review:publish'] as const) : []),
  ];
}

function repositoryAuthorizationFromGitHub(
  input: ReviewRepositorySelection,
  repository: {
    id: number;
    name: string;
    full_name: string;
    private?: boolean;
    visibility?: string;
    owner: { login: string };
    permissions?: Record<string, boolean>;
  },
  installationId: number
): ReviewRepositoryAuthorization {
  return {
    provider: 'github',
    repositoryId: repository.id,
    installationId,
    owner: repository.owner.login,
    name: repository.name,
    fullName: repository.full_name,
    visibility:
      repository.visibility === 'internal'
        ? 'internal'
        : repository.private
          ? 'private'
          : 'public',
    permissions: {
      metadata: 'read',
      ...(repository.permissions?.pull ? { contents: 'read' } : {}),
      ...(repository.permissions?.push ||
      repository.permissions?.maintain ||
      repository.permissions?.admin
        ? { pullRequests: 'write' }
        : {}),
    },
    ...(input.pullRequestNumber
      ? { pullRequestNumber: input.pullRequestNumber }
      : {}),
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.commitSha ? { commitSha: input.commitSha } : {}),
  };
}

/**
 * Creates a GitHub user-token repository authorizer using GitHub REST APIs.
 *
 * @param options - Optional GitHub API URL, API version, and per-request timeout.
 * @returns A verifier that revalidates identity and repository permissions.
 * @throws AuthHttpError - When the returned authorizer denies repository access or required scope.
 * @throws Error - When invalid options, GitHub API failures, or transport failures escape authorization.
 */
export function createGitHubUserTokenAuthorizer(
  options: {
    baseUrl?: string;
    apiVersion?: string;
    requestTimeoutMs?: number;
  } = {}
): GitHubUserTokenAuthorizer {
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_GITHUB_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error('requestTimeoutMs must be a positive finite number');
  }
  const baseUrl = options.baseUrl ?? DEFAULT_GITHUB_API_BASE_URL;
  const apiVersion =
    options.apiVersion ??
    (isPublicGitHubApiBaseUrl(baseUrl)
      ? DEFAULT_GITHUB_API_VERSION
      : undefined);
  const request = octokitRequest.defaults({
    baseUrl,
    headers: {
      accept: 'application/vnd.github+json',
      ...(apiVersion ? { 'x-github-api-version': apiVersion } : {}),
    },
  });
  const createRequestSignal = (): AbortSignal =>
    AbortSignal.timeout(requestTimeoutMs);
  const withTimeout = <TOptions extends Record<string, unknown>>(
    signal: AbortSignal,
    requestOptions?: TOptions
  ): TOptions & { request: { signal: AbortSignal } } => ({
    ...(requestOptions ?? ({} as TOptions)),
    request: { signal },
  });

  async function authenticateUserToken(
    token: string,
    signal = createRequestSignal()
  ): Promise<Extract<ReviewAuthPrincipal, { type: 'githubUser' }>> {
    const authRequest = request.defaults({
      headers: { authorization: `Bearer ${token}` },
    });
    const user = await authRequest('GET /user', withTimeout(signal));
    const userData = user.data as { id: number; login: string };
    return {
      type: 'githubUser',
      githubUserId: userData.id,
      login: userData.login,
    };
  }

  return {
    authenticateUserToken,
    async authorizeUserToken(token, selection, scope) {
      const signal = createRequestSignal();
      try {
        const authRequest = request.defaults({
          headers: { authorization: `Bearer ${token}` },
        });
        const principal = await authenticateUserToken(token, signal);
        const installationIds = selection.installationId
          ? [selection.installationId]
          : await (async () => {
              const ids: number[] = [];
              for (let page = 1; ; page += 1) {
                const installations = await authRequest(
                  'GET /user/installations',
                  withTimeout(signal, {
                    per_page: 100,
                    page,
                  })
                );
                const pageInstallations = (
                  installations.data as {
                    installations: Array<{
                      id: number;
                      suspended_at?: string | null;
                    }>;
                  }
                ).installations;
                ids.push(
                  ...pageInstallations
                    .filter((installation) => !installation.suspended_at)
                    .map((installation) => installation.id)
                );
                if (pageInstallations.length < 100) {
                  break;
                }
              }
              return ids;
            })();

        for (const installationId of installationIds) {
          for (let page = 1; ; page += 1) {
            const repositories = await authRequest(
              'GET /user/installations/{installation_id}/repositories',
              withTimeout(signal, {
                installation_id: installationId,
                per_page: 100,
                page,
              })
            );
            const pageRepositories = (
              repositories.data as {
                repositories: Array<{
                  id: number;
                  name: string;
                  full_name: string;
                  private?: boolean;
                  visibility?: string;
                  owner: { login: string };
                  permissions?: Record<string, boolean>;
                }>;
              }
            ).repositories;
            const repository = pageRepositories.find((candidate) => {
              if (selection.repositoryId !== undefined) {
                return candidate.id === selection.repositoryId;
              }
              return (
                candidate.owner.login.toLowerCase() ===
                  selection.owner.toLowerCase() &&
                candidate.name.toLowerCase() === selection.name.toLowerCase()
              );
            });
            if (repository) {
              const scopes = permissionScopes(repository.permissions ?? {});
              if (!scopeAllowed(scope, scopes)) {
                throw new AuthHttpError(403, 'github_permission_missing');
              }
              return {
                principal,
                repository: repositoryAuthorizationFromGitHub(
                  selection,
                  repository,
                  installationId
                ),
                scopes,
              };
            }
            if (pageRepositories.length < 100) {
              break;
            }
          }
        }

        throw new AuthHttpError(403, 'github_repository_not_accessible');
      } catch (error) {
        const authError = authHttpErrorFromUnknown(error);
        if (authError) {
          throw authError;
        }
        throw error;
      }
    },
  };
}

/**
 * Creates an installation token provider that always requests repository scoping.
 *
 * @param options - GitHub App credentials.
 * @returns Function that mints narrowed installation access tokens.
 * @throws Error - When the returned token request has no repository IDs.
 */
export function createGitHubAppInstallationTokenProvider(options: {
  appId: number | string;
  privateKey: string;
}): (
  input: GitHubInstallationTokenRequest
) => Promise<GitHubInstallationToken> {
  const auth = createAppAuth(options);
  return async (input) => {
    if (input.repositoryIds.length === 0) {
      throw new Error(
        'repositoryIds must contain at least one repository for installation token scoping'
      );
    }
    const authOptions: InstallationAuthOptions = {
      type: 'installation',
      installationId: input.installationId,
      repositoryIds: [...input.repositoryIds],
      ...(input.permissions ? { permissions: input.permissions } : {}),
    };
    const result: InstallationAccessTokenAuthentication =
      await auth(authOptions);
    return {
      token: result.token,
      expiresAt: Date.parse(result.expiresAt),
      permissions: result.permissions ?? {},
      ...(result.repositorySelection
        ? { repositorySelection: result.repositorySelection }
        : {}),
    };
  };
}

/**
 * Produces the hash stored with review runs to detect replayed or mixed requests.
 *
 * @param input - Review request payload or compatible structured value.
 * @returns Stable SHA-256 hash string with the `sha256:` prefix.
 */
export function reviewRequestHash(input: unknown): string {
  return `sha256:${createHash('sha256')
    .update(stableSerialize(input))
    .digest('hex')}`;
}

function stableSerialize(input: unknown): string {
  return (
    JSON.stringify(input, (_key, value: unknown) => {
      if (value === null || Array.isArray(value) || typeof value !== 'object') {
        return value;
      }
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).sort(
          ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)
        )
      );
    }) ?? 'null'
  );
}

/**
 * Converts a persisted repository authorization into a request selection.
 *
 * @param repository - Stored repository authorization snapshot.
 * @returns Repository selection suitable for dynamic authorization checks.
 */
export function repositorySelectionFromAuthorization(
  repository: ReviewRepositoryAuthorization
): ReviewRepositorySelection {
  return {
    provider: 'github',
    owner: repository.owner,
    name: repository.name,
    repositoryId: repository.repositoryId,
    installationId: repository.installationId,
    ...(repository.pullRequestNumber
      ? { pullRequestNumber: repository.pullRequestNumber }
      : {}),
    ...(repository.ref ? { ref: repository.ref } : {}),
    ...(repository.commitSha ? { commitSha: repository.commitSha } : {}),
  };
}
