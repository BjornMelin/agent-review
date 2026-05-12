import { describe, expect, it } from 'vitest';
import {
  authorizeReviewRoomRequest,
  resolveReviewRoomAccessConfig,
} from './review-room-access';

function headers(input: Record<string, string>): Headers {
  return new Headers(input);
}

describe('resolveReviewRoomAccessConfig', () => {
  it('reports production runtime when deployed under Vercel preview', () => {
    expect(
      resolveReviewRoomAccessConfig({
        VERCEL_ENV: 'preview',
        REVIEW_WEB_ACCESS_TOKEN: 'gate',
      })
    ).toEqual({
      accessToken: 'gate',
      tokenSource: 'REVIEW_WEB_ACCESS_TOKEN',
      productionRuntime: true,
    });
  });
});

describe('authorizeReviewRoomRequest', () => {
  it('allows local development when no access token is configured', () => {
    expect(
      authorizeReviewRoomRequest(headers({}), { NODE_ENV: 'development' })
    ).toEqual({ ok: true });
  });

  it('fails closed in production when no access token is configured', () => {
    expect(
      authorizeReviewRoomRequest(headers({}), { NODE_ENV: 'production' })
    ).toEqual({
      ok: false,
      error: 'review room access token is not configured',
      status: 503,
    });
  });

  it('accepts the explicit Review Room access header', () => {
    expect(
      authorizeReviewRoomRequest(
        headers({ 'x-review-room-access-token': 'gate' }),
        {
          NODE_ENV: 'production',
          REVIEW_WEB_ACCESS_TOKEN: 'gate',
        }
      )
    ).toEqual({ ok: true });
  });

  it('accepts browser Basic auth password access', () => {
    expect(
      authorizeReviewRoomRequest(
        headers({
          authorization: `Basic ${Buffer.from('operator:gate').toString('base64')}`,
        }),
        {
          NODE_ENV: 'production',
          REVIEW_WEB_ACCESS_TOKEN: 'gate',
        }
      )
    ).toEqual({ ok: true });
  });

  it('rejects missing or wrong credentials when an access token is configured', () => {
    expect(
      authorizeReviewRoomRequest(headers({ authorization: 'Bearer wrong' }), {
        NODE_ENV: 'production',
        REVIEW_WEB_ACCESS_TOKEN: 'gate',
      })
    ).toEqual({
      ok: false,
      error: 'review room access required',
      status: 401,
      authenticate: 'Basic realm="Review Room", charset="UTF-8"',
    });
  });
});
