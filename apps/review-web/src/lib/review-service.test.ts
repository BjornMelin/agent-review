import { describe, expect, it } from 'vitest';
import {
  normalizeReviewServiceUrl,
  resolveReviewWebConfig,
} from './review-service';

describe('resolveReviewWebConfig', () => {
  it('uses Review Room-specific env before shared service env', () => {
    expect(
      resolveReviewWebConfig({
        REVIEW_WEB_SERVICE_URL: 'https://web.example.com/',
        REVIEW_AGENT_SERVICE_URL: 'https://agent.example.com',
        REVIEW_WEB_SERVICE_TOKEN: 'rat_web_secret',
        REVIEW_AGENT_SERVICE_TOKEN: 'rat_agent_secret',
      })
    ).toEqual({
      serviceUrl: 'https://web.example.com',
      token: 'rat_web_secret',
      tokenSource: 'REVIEW_WEB_SERVICE_TOKEN',
    });
  });

  it('falls back to the local service URL without requiring a token', () => {
    expect(resolveReviewWebConfig({})).toEqual({
      serviceUrl: 'http://localhost:3042',
    });
  });
});

describe('normalizeReviewServiceUrl', () => {
  it('allows HTTPS remote service origins and local HTTP origins', () => {
    expect(normalizeReviewServiceUrl('https://service.example.com/')).toBe(
      'https://service.example.com'
    );
    expect(normalizeReviewServiceUrl('http://127.0.0.1:3042/')).toBe(
      'http://127.0.0.1:3042'
    );
  });

  it('rejects unsafe service token destinations', () => {
    expect(() =>
      normalizeReviewServiceUrl('http://service.example.com')
    ).toThrow(
      'review service URL must use HTTPS unless it targets localhost or loopback'
    );
    expect(() =>
      normalizeReviewServiceUrl('https://user:pass@service.example.com')
    ).toThrow('review service URL must not contain credentials');
    expect(() =>
      normalizeReviewServiceUrl('https://service.example.com?token=leak')
    ).toThrow('review service URL must not include query strings or fragments');
  });
});
