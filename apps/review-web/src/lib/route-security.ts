import type { ReviewRoomAccessResult } from './review-room-access';

export type MutationGuardResult =
  | { ok: true }
  | { ok: false; error: string; status: 400 | 403 };

function expectedOrigin(request: Request): string | undefined {
  return new URL(request.url).origin;
}

/**
 * Validates same-origin Review Room mutation requests and action headers.
 *
 * @param request - Incoming mutation request.
 * @param expectedAction - Route-specific mutation action expected by the handler.
 * @returns Guard result describing whether the request is accepted or rejected.
 */
export function validateReviewRoomMutation(
  request: Request,
  expectedAction: 'cancel' | 'publish' | 'triage'
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
