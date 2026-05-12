import { isIP } from 'node:net';
import {
  type OutputFormat,
  type ReviewCancelResponse,
  ReviewCancelResponseSchema,
  type ReviewPublishResponse,
  ReviewPublishResponseSchema,
  type ReviewRunListResponse,
  ReviewRunListResponseSchema,
  type ReviewStatusResponse,
  ReviewStatusResponseSchema,
} from '@review-agent/review-types';

const DEFAULT_SERVICE_URL = 'http://localhost:3042';
const SERVICE_URL_ENV_KEYS = [
  'REVIEW_WEB_SERVICE_URL',
  'REVIEW_AGENT_SERVICE_URL',
  'REVIEW_SERVICE_URL',
] as const;
const SERVICE_TOKEN_ENV_KEYS = [
  'REVIEW_WEB_SERVICE_TOKEN',
  'REVIEW_AGENT_SERVICE_TOKEN',
  'REVIEW_SERVICE_TOKEN',
] as const;

export type ReviewWebConfig = {
  serviceUrl: string;
  token?: string;
  tokenSource?: string;
};

export type ReviewServiceReadResult<T> =
  | { ok: true; data: T; serviceUrl: string }
  | { ok: false; error: string; serviceUrl: string; status?: number };

export class ReviewWebConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewWebConfigError';
  }
}

function envValue(
  env: Record<string, string | undefined>,
  keys: readonly string[]
): { key: string; value: string } | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return { key, value };
    }
  }
  return undefined;
}

function isLocalServiceHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === '::1' ||
    (isIP(hostname) === 4 && hostname.startsWith('127.'))
  );
}

export function normalizeReviewServiceUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) {
      throw new ReviewWebConfigError(
        'review service URL must not contain credentials'
      );
    }
    if (parsed.search || parsed.hash) {
      throw new ReviewWebConfigError(
        'review service URL must not include query strings or fragments'
      );
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ReviewWebConfigError(
        'review service URL must use HTTP or HTTPS'
      );
    }
    if (parsed.protocol === 'http:' && !isLocalServiceHost(parsed.hostname)) {
      throw new ReviewWebConfigError(
        'review service URL must use HTTPS unless it targets localhost or loopback'
      );
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch (error) {
    if (error instanceof ReviewWebConfigError) {
      throw error;
    }
    throw new ReviewWebConfigError('invalid review service URL');
  }
}

export function resolveReviewWebConfig(
  env: Record<string, string | undefined> = process.env
): ReviewWebConfig {
  const serviceUrl = envValue(env, SERVICE_URL_ENV_KEYS)?.value;
  const token = envValue(env, SERVICE_TOKEN_ENV_KEYS);
  return {
    serviceUrl: normalizeReviewServiceUrl(serviceUrl ?? DEFAULT_SERVICE_URL),
    ...(token ? { token: token.value, tokenSource: token.key } : {}),
  };
}

function serviceHeaders(config: ReviewWebConfig): Headers {
  const headers = new Headers({ accept: 'application/json' });
  if (config.token) {
    headers.set('authorization', `Bearer ${config.token}`);
  }
  return headers;
}

export function createServiceRequest(
  path: string,
  init: RequestInit = {}
): { url: string; init: RequestInit; serviceUrl: string } {
  const config = resolveReviewWebConfig();
  const headers = serviceHeaders(config);
  if (init.headers) {
    for (const [key, value] of new Headers(init.headers)) {
      headers.set(key, value);
    }
  }
  return {
    url: `${config.serviceUrl}${path}`,
    init: {
      ...init,
      headers,
      cache: 'no-store',
    },
    serviceUrl: config.serviceUrl,
  };
}

async function serviceJson<T>(
  path: string,
  parse: (input: unknown) => T,
  init: RequestInit = {}
): Promise<ReviewServiceReadResult<T>> {
  let serviceUrl = 'unavailable';
  try {
    const request = createServiceRequest(path, init);
    serviceUrl = request.serviceUrl;
    const response = await fetch(request.url, request.init);
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error =
        body &&
        typeof body === 'object' &&
        'error' in body &&
        typeof body.error === 'string'
          ? body.error
          : `review service returned HTTP ${response.status}`;
      return {
        ok: false,
        error,
        serviceUrl: request.serviceUrl,
        status: response.status,
      };
    }
    return {
      ok: true,
      data: parse(body),
      serviceUrl: request.serviceUrl,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : 'failed to reach review service',
      serviceUrl,
    };
  }
}

export function getReviewRuns(
  input: { limit?: number; status?: string; owner?: string; name?: string } = {}
): Promise<ReviewServiceReadResult<ReviewRunListResponse>> {
  const params = new URLSearchParams();
  if (input.limit) {
    params.set('limit', String(input.limit));
  }
  if (input.status) {
    params.set('status', input.status);
  }
  if (input.owner && input.name) {
    params.set('owner', input.owner);
    params.set('name', input.name);
  }
  const suffix = params.size > 0 ? `?${params}` : '';
  return serviceJson(`/v1/review${suffix}`, ReviewRunListResponseSchema.parse);
}

export function getReviewStatus(
  reviewId: string
): Promise<ReviewServiceReadResult<ReviewStatusResponse>> {
  return serviceJson(
    `/v1/review/${encodeURIComponent(reviewId)}`,
    ReviewStatusResponseSchema.parse
  );
}

export function cancelReview(
  reviewId: string
): Promise<ReviewServiceReadResult<ReviewCancelResponse>> {
  return serviceJson(
    `/v1/review/${encodeURIComponent(reviewId)}/cancel`,
    ReviewCancelResponseSchema.parse,
    { method: 'POST' }
  );
}

export function publishReview(
  reviewId: string
): Promise<ReviewServiceReadResult<ReviewPublishResponse>> {
  return serviceJson(
    `/v1/review/${encodeURIComponent(reviewId)}/publish`,
    ReviewPublishResponseSchema.parse,
    { method: 'POST' }
  );
}

export function artifactHref(reviewId: string, format: OutputFormat): string {
  return `/api/review/${encodeURIComponent(reviewId)}/artifacts/${format}`;
}
