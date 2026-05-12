import { afterEach, describe, expect, it, vi } from 'vitest';
import { PATCH } from './route';

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

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv();
});

describe('PATCH /api/review/:reviewId/findings/:fingerprint/triage', () => {
  it('rejects malformed JSON before proxying to the review service', async () => {
    delete process.env.REVIEW_WEB_ACCESS_TOKEN;
    process.env.VERCEL_ENV = 'development';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await PATCH(
      new Request(
        'http://localhost:3000/api/review/review-1/findings/finding-1/triage',
        {
          body: '{',
          headers: {
            origin: 'http://localhost:3000',
            'x-review-room-action': 'triage',
          },
          method: 'PATCH',
        }
      ),
      {
        params: Promise.resolve({
          fingerprint: 'finding-1',
          reviewId: 'review-1',
        }),
      }
    );

    await expect(response.json()).resolves.toEqual({
      error: 'invalid JSON body',
    });
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
