import { afterEach, describe, expect, it } from 'vitest';
import { GET } from './route';

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  REVIEW_WEB_ACCESS_TOKEN: process.env.REVIEW_WEB_ACCESS_TOKEN,
  REVIEW_WEB_SERVICE_TOKEN: process.env.REVIEW_WEB_SERVICE_TOKEN,
  REVIEW_WEB_SERVICE_URL: process.env.REVIEW_WEB_SERVICE_URL,
  VERCEL_ENV: process.env.VERCEL_ENV,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  restoreEnv();
});

describe('GET /api/health', () => {
  it('reports non-secret preview readiness without requiring browser credentials', async () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.REVIEW_WEB_ACCESS_TOKEN = 'access-token';
    process.env.REVIEW_WEB_SERVICE_TOKEN = 'service-token';
    process.env.REVIEW_WEB_SERVICE_URL = 'https://service.example.com';

    const response = GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accessTokenConfigured: true,
      ok: true,
      productionRuntime: true,
      serviceTokenConfigured: true,
    });
  });
});
