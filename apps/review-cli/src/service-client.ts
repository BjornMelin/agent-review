import { isIP } from 'node:net';

import {
  type LifecycleEvent,
  LifecycleEventSchema,
  OutputFormatSchema,
  ReviewCancelResponseSchema,
  ReviewErrorResponseSchema,
  type ReviewPublishResponse,
  ReviewPublishResponseSchema,
  type ReviewStartRequest,
  type ReviewStartResponse,
  ReviewStartResponseSchema,
  type ReviewStatusResponse,
  ReviewStatusResponseSchema,
  redactSensitiveText,
} from '@review-agent/review-types';

const DEFAULT_SERVICE_URL = 'http://localhost:3042';
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_SSE_BUFFER_BYTES = 1024 * 1024;
const SERVICE_URL_ENV_KEYS = ['REVIEW_AGENT_SERVICE_URL', 'REVIEW_SERVICE_URL'];
const SERVICE_TOKEN_ENV_KEYS = [
  'REVIEW_AGENT_SERVICE_TOKEN',
  'REVIEW_SERVICE_TOKEN',
];

type Schema<T> = {
  parse(input: unknown): T;
};

export type ServiceConfigInput = {
  serviceUrl?: string;
  serviceToken?: string;
};

export type ReviewServiceConfig = {
  baseUrl: string;
  token: string;
};

export type WatchEventsOptions = {
  afterEventId?: string;
  limit?: number;
  onEvent: (event: LifecycleEvent) => void | Promise<void>;
};

export class ServiceClientError extends Error {
  readonly exitCode: number;
  readonly status?: number;

  constructor(message: string, exitCode: number, status?: number) {
    super(message);
    this.name = 'ServiceClientError';
    this.exitCode = exitCode;
    if (status !== undefined) {
      this.status = status;
    }
  }
}

function firstNonEmpty(
  values: Array<string | undefined>,
  fallback?: string
): string | undefined {
  for (const value of values) {
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return fallback;
}

function envValue(
  env: NodeJS.ProcessEnv,
  keys: readonly string[]
): string | undefined {
  return firstNonEmpty(keys.map((key) => env[key]));
}

function isLocalServiceHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === '::1' ||
    (isIP(hostname) === 4 && hostname.startsWith('127.'))
  );
}

function normalizeServiceUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) {
      throw new ServiceClientError(
        'review service URL must not contain credentials',
        2
      );
    }
    if (parsed.protocol === 'http:' && !isLocalServiceHost(parsed.hostname)) {
      throw new ServiceClientError(
        'review service URL must use HTTPS unless it targets localhost or loopback',
        2
      );
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ServiceClientError(
        'review service URL must use HTTP or HTTPS',
        2
      );
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch (error) {
    if (error instanceof ServiceClientError) {
      throw error;
    }
    const redactedUrl = redactSensitiveText(rawUrl).text;
    throw new ServiceClientError(
      `invalid review service URL "${redactedUrl}"`,
      2
    );
  }
}

export function resolveReviewServiceConfig(
  input: ServiceConfigInput,
  env: NodeJS.ProcessEnv = process.env
): ReviewServiceConfig {
  const baseUrl = normalizeServiceUrl(
    firstNonEmpty(
      [input.serviceUrl, envValue(env, SERVICE_URL_ENV_KEYS)],
      DEFAULT_SERVICE_URL
    ) ?? DEFAULT_SERVICE_URL
  );
  const token = firstNonEmpty([
    input.serviceToken,
    envValue(env, SERVICE_TOKEN_ENV_KEYS),
  ]);

  if (!token) {
    throw new ServiceClientError(
      'review service token is required; set REVIEW_AGENT_SERVICE_TOKEN or pass --service-token',
      3
    );
  }

  return { baseUrl, token };
}

function buildServiceUrl(
  config: ReviewServiceConfig,
  path: string,
  query?: URLSearchParams
): string {
  const base = new URL(`${config.baseUrl}/`);
  const url = new URL(path.replace(/^\//, ''), base);
  if (query) {
    url.search = query.toString();
  }
  return url.toString();
}

function statusToExitCode(status: number): number {
  if (status === 401 || status === 403) {
    return 3;
  }
  if (status === 400 || status === 404 || status === 409 || status === 413) {
    return 2;
  }
  return 4;
}

function redactServiceText(text: string, token: string): string {
  const redacted = redactSensitiveText(text).text;
  return token.length > 0
    ? redacted.replaceAll(token, '[REDACTED_SECRET]')
    : redacted;
}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) {
    return '';
  }

  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    const remainingBytes = MAX_ERROR_BODY_BYTES - receivedBytes;
    if (remainingBytes <= 0) {
      break;
    }
    const nextChunk =
      chunk.byteLength > remainingBytes
        ? chunk.slice(0, remainingBytes)
        : chunk;
    chunks.push(nextChunk);
    receivedBytes += nextChunk.byteLength;
    if (chunk.byteLength > remainingBytes) {
      break;
    }
  }

  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function responseError(
  response: Response,
  token: string
): Promise<ServiceClientError> {
  let message = `review service request failed with HTTP ${response.status}`;
  const text = await boundedResponseText(response);
  if (text.trim().length > 0) {
    try {
      const parsed = ReviewErrorResponseSchema.parse(JSON.parse(text));
      message = parsed.error;
    } catch {
      message = text;
    }
  }
  message = redactServiceText(message, token);
  return new ServiceClientError(
    message,
    statusToExitCode(response.status),
    response.status
  );
}

async function serviceFetch(
  config: ReviewServiceConfig,
  path: string,
  init: RequestInit = {},
  query?: URLSearchParams
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(buildServiceUrl(config, path, query), {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.token}`,
        ...init.headers,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ServiceClientError(
      `review service request failed: ${redactServiceText(message, config.token)}`,
      4
    );
  }

  if (!response.ok) {
    throw await responseError(response, config.token);
  }
  return response;
}

async function serviceJson<T>(
  config: ReviewServiceConfig,
  path: string,
  schema: Schema<T>,
  init: RequestInit = {},
  query?: URLSearchParams
): Promise<T> {
  const response = await serviceFetch(config, path, init, query);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ServiceClientError(
      `review service returned invalid JSON for ${path}`,
      4,
      response.status
    );
  }

  try {
    return schema.parse(body);
  } catch {
    throw new ServiceClientError(
      `review service returned invalid response for ${path}`,
      4,
      response.status
    );
  }
}

function jsonPostInit(body?: unknown): RequestInit {
  return {
    method: 'POST',
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
        }),
  };
}

export function startReview(
  config: ReviewServiceConfig,
  request: ReviewStartRequest
): Promise<ReviewStartResponse> {
  return serviceJson(config, '/v1/review/start', ReviewStartResponseSchema, {
    method: 'POST',
    body: JSON.stringify(request),
    headers: { 'Content-Type': 'application/json' },
  });
}

export function getReviewStatus(
  config: ReviewServiceConfig,
  reviewId: string
): Promise<ReviewStatusResponse> {
  return serviceJson(
    config,
    `/v1/review/${encodeURIComponent(reviewId)}`,
    ReviewStatusResponseSchema
  );
}

export function cancelReview(config: ReviewServiceConfig, reviewId: string) {
  return serviceJson(
    config,
    `/v1/review/${encodeURIComponent(reviewId)}/cancel`,
    ReviewCancelResponseSchema,
    jsonPostInit()
  );
}

export function publishReview(
  config: ReviewServiceConfig,
  reviewId: string
): Promise<ReviewPublishResponse> {
  return serviceJson(
    config,
    `/v1/review/${encodeURIComponent(reviewId)}/publish`,
    ReviewPublishResponseSchema,
    jsonPostInit()
  );
}

export async function fetchReviewArtifact(
  config: ReviewServiceConfig,
  reviewId: string,
  format: string
): Promise<Buffer> {
  const parsedFormat = OutputFormatSchema.parse(format);
  const response = await serviceFetch(
    config,
    `/v1/review/${encodeURIComponent(reviewId)}/artifacts/${parsedFormat}`,
    { headers: { Accept: '*/*' } }
  );
  return Buffer.from(await response.arrayBuffer());
}

function parseSseFrames(buffer: string): {
  frames: Array<{ event?: string; id?: string; data: string }>;
  remainder: string;
} {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const remainder = blocks.pop() ?? '';
  const frames: Array<{ event?: string; id?: string; data: string }> = [];

  for (const block of blocks) {
    const dataLines: string[] = [];
    let event: string | undefined;
    let id: string | undefined;
    for (const line of block.split('\n')) {
      if (line.length === 0 || line.startsWith(':')) {
        continue;
      }
      const separatorIndex = line.indexOf(':');
      const field =
        separatorIndex === -1 ? line : line.slice(0, separatorIndex);
      const rawValue =
        separatorIndex === -1 ? '' : line.slice(separatorIndex + 1);
      const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
      if (field === 'event') {
        event = value;
      } else if (field === 'id') {
        id = value;
      } else if (field === 'data') {
        dataLines.push(value);
      }
    }

    frames.push({
      ...(event ? { event } : {}),
      ...(id ? { id } : {}),
      data: dataLines.join('\n'),
    });
  }

  return { frames, remainder };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export async function watchReviewEvents(
  config: ReviewServiceConfig,
  reviewId: string,
  options: WatchEventsOptions
): Promise<number> {
  const query = new URLSearchParams();
  if (options.afterEventId) {
    query.set('afterEventId', options.afterEventId);
  }
  if (options.limit !== undefined) {
    query.set('limit', String(options.limit));
  }

  const controller = new AbortController();
  const response = await serviceFetch(
    config,
    `/v1/review/${encodeURIComponent(reviewId)}/events`,
    {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    },
    query
  );
  if (!response.body) {
    throw new ServiceClientError('review service event stream had no body', 4);
  }

  let exitCode = 0;
  let buffer = '';
  let terminalExitCode: number | undefined;
  const decoder = new TextDecoder();

  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      if (Buffer.byteLength(buffer) > MAX_SSE_BUFFER_BYTES) {
        throw new ServiceClientError(
          'review service SSE buffer exceeded the CLI safety limit',
          4
        );
      }
      const parsed = parseSseFrames(buffer);
      buffer = parsed.remainder;

      for (const frame of parsed.frames) {
        if (terminalExitCode !== undefined && frame.event === 'keepalive') {
          return terminalExitCode;
        }
        if (frame.event === 'keepalive' || frame.data.length === 0) {
          continue;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(frame.data);
        } catch {
          throw new ServiceClientError(
            'review service returned invalid SSE event JSON',
            4
          );
        }
        let event: LifecycleEvent;
        try {
          event = LifecycleEventSchema.parse(payload);
        } catch {
          throw new ServiceClientError(
            'review service returned invalid SSE event payload',
            4
          );
        }
        await options.onEvent(event);
        if (event.type === 'failed' || event.type === 'cancelled') {
          exitCode = 4;
          terminalExitCode = exitCode;
          controller.abort();
          break;
        }
        if (event.type === 'exitedReviewMode') {
          terminalExitCode = exitCode;
        }
      }
      if (terminalExitCode !== undefined && exitCode !== 0) {
        break;
      }
    }
  } catch (error) {
    if (terminalExitCode !== undefined && isAbortError(error)) {
      return terminalExitCode;
    }
    throw error;
  } finally {
    controller.abort();
  }

  if (terminalExitCode !== undefined) {
    return terminalExitCode;
  }

  throw new ServiceClientError(
    'review service event stream ended before a terminal lifecycle event',
    4
  );
}
