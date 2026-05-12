import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

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

describe('GET /api/review/:reviewId/publish/preview', () => {
  it('marks publication preview responses as non-cacheable', async () => {
    delete process.env.REVIEW_WEB_ACCESS_TOKEN;
    process.env.VERCEL_ENV = 'development';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          reviewId: 'review-1',
          target: {
            owner: 'owner',
            repo: 'repo',
            repositoryId: 123,
            installationId: 456,
            commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
          items: [],
          existingPublications: [],
          summary: {
            pullRequestCommentCount: 0,
            blockedCount: 0,
          },
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    );

    const response = await GET(
      new Request('http://localhost:3000/api/review/review-1/publish/preview'),
      { params: Promise.resolve({ reviewId: 'review-1' }) }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
