import { describe, expect, it } from 'vitest';
import { validateReviewRoomMutation } from './route-security';

function request(
  headers: Record<string, string>,
  url = 'http://localhost:3000/api/review/review_1/cancel'
): Request {
  return new Request(url, { method: 'POST', headers });
}

describe('validateReviewRoomMutation', () => {
  it('accepts same-origin mutation requests with the expected action header', () => {
    expect(
      validateReviewRoomMutation(
        request({
          host: 'localhost:3000',
          origin: 'http://localhost:3000',
          'x-review-room-action': 'cancel',
        }),
        'cancel'
      )
    ).toEqual({ ok: true });
  });

  it('rejects cross-origin mutation requests before proxying service tokens', () => {
    expect(
      validateReviewRoomMutation(
        request({
          host: 'localhost:3000',
          origin: 'https://attacker.example',
          'x-review-room-action': 'cancel',
        }),
        'cancel'
      )
    ).toEqual({
      ok: false,
      error: 'cross-origin mutation request denied',
      status: 403,
    });
  });

  it('requires the route-specific mutation header', () => {
    expect(
      validateReviewRoomMutation(
        request({
          host: 'localhost:3000',
          origin: 'http://localhost:3000',
          'x-review-room-action': 'publish',
        }),
        'cancel'
      )
    ).toEqual({
      ok: false,
      error: 'review room mutation header required',
      status: 403,
    });
  });
});
