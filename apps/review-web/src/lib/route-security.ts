import type { ReviewRoomAccessResult } from './review-room-access';

export type MutationGuardResult =
  | { ok: true }
  | { ok: false; error: string; status: 400 | 403 };

function expectedOrigin(request: Request): string | undefined {
  const forwardedHost =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const host = forwardedHost?.split(',')[0]?.trim();
  if (!host) {
    return undefined;
  }
  const requestUrl = new URL(request.url);
  const forwardedProto = request.headers
    .get('x-forwarded-proto')
    ?.split(',')[0];
  const proto = forwardedProto?.trim() || requestUrl.protocol.replace(/:$/, '');
  return `${proto}://${host}`;
}

export function validateReviewRoomMutation(
  request: Request,
  expectedAction: 'cancel' | 'publish'
): MutationGuardResult {
  const origin = request.headers.get('origin');
  const expected = expectedOrigin(request);
  if (!origin || !expected) {
    return {
      ok: false,
      error: 'same-origin mutation request required',
      status: 400,
    };
  }
  if (origin !== expected) {
    return {
      ok: false,
      error: 'cross-origin mutation request denied',
      status: 403,
    };
  }
  if (request.headers.get('x-review-room-action') !== expectedAction) {
    return {
      ok: false,
      error: 'review room mutation header required',
      status: 403,
    };
  }
  return { ok: true };
}

export function reviewRoomAccessHeaders(
  access: ReviewRoomAccessResult
): HeadersInit {
  return access.ok || !access.authenticate
    ? {}
    : { 'WWW-Authenticate': access.authenticate };
}
