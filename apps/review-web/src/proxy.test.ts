import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import { proxy } from './proxy';

const ORIGINAL_ENV = {
  REVIEW_WEB_ACCESS_TOKEN: process.env.REVIEW_WEB_ACCESS_TOKEN,
  VERCEL_ENV: process.env.VERCEL_ENV,
};

function restoreEnv(): void {
  if (ORIGINAL_ENV.REVIEW_WEB_ACCESS_TOKEN === undefined) {
    delete process.env.REVIEW_WEB_ACCESS_TOKEN;
  } else {
    process.env.REVIEW_WEB_ACCESS_TOKEN = ORIGINAL_ENV.REVIEW_WEB_ACCESS_TOKEN;
  }
  if (ORIGINAL_ENV.VERCEL_ENV === undefined) {
    delete process.env.VERCEL_ENV;
  } else {
    process.env.VERCEL_ENV = ORIGINAL_ENV.VERCEL_ENV;
  }
}

function requireReviewRoomAccess(): void {
  process.env.VERCEL_ENV = 'preview';
  process.env.REVIEW_WEB_ACCESS_TOKEN = 'gate';
}

afterEach(() => {
  restoreEnv();
});

describe('proxy', () => {
  it('returns a Basic auth challenge for protected pages', async () => {
    requireReviewRoomAccess();

    const response = proxy(
      new NextRequest('https://review.example.com/runs/1')
    );

    expect(response?.status).toBe(401);
    expect(response?.headers.get('www-authenticate')).toBe(
      'Basic realm="Review Room", charset="UTF-8"'
    );
    expect(response?.headers.get('content-type')).toContain('text/html');
    await expect(response?.text()).resolves.toContain(
      'Review Room access required'
    );
  });

  it('returns JSON access errors for API proxy routes', async () => {
    requireReviewRoomAccess();

    const response = proxy(
      new NextRequest('https://review.example.com/api/review/1/cancel')
    );

    expect(response?.status).toBe(401);
    expect(response?.headers.get('www-authenticate')).toBe(
      'Basic realm="Review Room", charset="UTF-8"'
    );
    await expect(response?.json()).resolves.toEqual({
      error: 'review room access required',
    });
  });

  it('leaves public health checks reachable in protected previews', () => {
    requireReviewRoomAccess();

    const response = proxy(
      new NextRequest('https://review.example.com/api/health')
    );

    expect(response).toBeUndefined();
  });

  it('lets valid Basic credentials continue to the routed page', () => {
    requireReviewRoomAccess();

    const response = proxy(
      new NextRequest('https://review.example.com/runs/1', {
        headers: {
          authorization: `Basic ${Buffer.from('operator:gate').toString(
            'base64'
          )}`,
        },
      })
    );

    expect(response).toBeUndefined();
  });
});
