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

describe('GET /api/review/:reviewId/events', () => {
  it('forwards Last-Event-ID to the upstream review service', async () => {
    delete process.env.REVIEW_WEB_ACCESS_TOKEN;
    process.env.VERCEL_ENV = 'development';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('event: progress\ndata: {"ok": true}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    );

    const response = await GET(
      new Request('http://localhost:3000/api/review/review_1/events', {
        headers: { 'last-event-id': 'review_1:0002' },
      }),
      { params: Promise.resolve({ reviewId: 'review_1' }) }
    );

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get('last-event-id')).toBe(
      'review_1:0002'
    );
    expect(new Headers(init?.headers).get('accept')).toBe('text/event-stream');
  });
});
