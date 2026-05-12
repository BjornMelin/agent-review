import { timingSafeEqual } from 'node:crypto';

type HeaderReader = Pick<Headers, 'get'>;

export type ReviewRoomAccessConfig = {
  accessToken?: string;
  tokenSource?: string;
  productionRuntime: boolean;
};

export type ReviewRoomAccessResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      status: 401 | 503;
      authenticate?: string;
    };

const ACCESS_TOKEN_ENV_KEYS = ['REVIEW_WEB_ACCESS_TOKEN'] as const;

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

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function bearerToken(headers: HeaderReader): string | undefined {
  const authorization = headers.get('authorization')?.trim();
  if (!authorization?.toLowerCase().startsWith('bearer ')) {
    return undefined;
  }
  return authorization.slice('bearer '.length).trim();
}

function basicPassword(headers: HeaderReader): string | undefined {
  const authorization = headers.get('authorization')?.trim();
  if (!authorization?.toLowerCase().startsWith('basic ')) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(
      authorization.slice('basic '.length).trim(),
      'base64'
    ).toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    return separatorIndex === -1 ? decoded : decoded.slice(separatorIndex + 1);
  } catch {
    return undefined;
  }
}

export function resolveReviewRoomAccessConfig(
  env: Record<string, string | undefined> = process.env
): ReviewRoomAccessConfig {
  const token = envValue(env, ACCESS_TOKEN_ENV_KEYS);
  return {
    ...(token ? { accessToken: token.value, tokenSource: token.key } : {}),
    productionRuntime:
      env.NODE_ENV === 'production' ||
      env.VERCEL_ENV === 'production' ||
      env.VERCEL_ENV === 'preview',
  };
}

export function authorizeReviewRoomRequest(
  headers: HeaderReader,
  env: Record<string, string | undefined> = process.env
): ReviewRoomAccessResult {
  const config = resolveReviewRoomAccessConfig(env);
  if (!config.accessToken) {
    if (!config.productionRuntime) {
      return { ok: true };
    }
    return {
      ok: false,
      error: 'review room access token is not configured',
      status: 503,
    };
  }

  const suppliedToken =
    headers.get('x-review-room-access-token')?.trim() ??
    bearerToken(headers) ??
    basicPassword(headers);
  if (suppliedToken && secureEqual(suppliedToken, config.accessToken)) {
    return { ok: true };
  }
  return {
    ok: false,
    error: 'review room access required',
    status: 401,
    authenticate: 'Basic realm="Review Room", charset="UTF-8"',
  };
}
