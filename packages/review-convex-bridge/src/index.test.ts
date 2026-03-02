import type { ReviewResult } from '@review-agent/review-types';
import { describe, expect, it, vi } from 'vitest';
import { ConvexMetadataBridge } from './index.js';

const baseResult: ReviewResult = {
  findings: [],
  overallCorrectness: 'patch is correct',
  overallExplanation: 'ok',
  overallConfidenceScore: 0.8,
  metadata: {
    provider: 'codexDelegate',
    modelResolved: 'model',
    executionMode: 'localTrusted',
    promptPack: 'pack',
    gitContext: { mode: 'uncommitted' },
  },
};

describe('convex metadata bridge', () => {
  it('degrades gracefully when disabled', async () => {
    const bridge = new ConvexMetadataBridge({ url: '' });
    expect(bridge.isEnabled()).toBe(false);
    await expect(bridge.mirrorWrite('id', baseResult)).resolves.toBe(false);
    await expect(bridge.readSummary('id')).resolves.toBeNull();

    const health = await bridge.health();
    expect(health.enabled).toBe(false);
    expect(health.reachable).toBe(false);
  });

  it('keeps mirror-write/read failures non-blocking', async () => {
    const client = {
      mutation: vi.fn(async () => {
        throw new Error('mutation failed');
      }),
      query: vi.fn(async () => {
        throw new Error('query failed');
      }),
    };
    const bridge = new ConvexMetadataBridge({ client });

    await expect(bridge.mirrorWrite('id', baseResult)).resolves.toBe(false);
    await expect(bridge.readSummary('id')).resolves.toBeNull();

    const health = await bridge.health();
    expect(health.enabled).toBe(true);
    expect(health.reachable).toBe(false);
  });

  it('handles missing query clients via fallback', async () => {
    const client = {
      mutation: vi.fn(async () => undefined),
    };
    const bridge = new ConvexMetadataBridge({ client });

    await expect(bridge.mirrorWrite('id', baseResult)).resolves.toBe(true);
    await expect(bridge.readSummary('id')).resolves.toBeNull();

    const health = await bridge.health();
    expect(health.enabled).toBe(true);
    expect(health.reachable).toBe(false);
    expect(health.detail).toBe('Convex query client is unavailable');
  });

  it('returns summary and reachable health with query support', async () => {
    const summary = {
      reviewId: 'id',
      provider: 'codexDelegate',
      model: 'model',
      findingsCount: 0,
      overallCorrectness: 'patch is correct',
      summary: 'ok',
      completedAt: Date.now(),
    };
    const client = {
      mutation: vi.fn(async () => undefined),
      query: vi.fn(async (functionName: string) => {
        if (functionName.includes('health')) {
          return { ok: true };
        }
        return summary;
      }),
    };
    const bridge = new ConvexMetadataBridge({ client });

    await expect(bridge.mirrorWrite('id', baseResult)).resolves.toBe(true);
    await expect(bridge.readSummary('id')).resolves.toEqual(summary);

    const health = await bridge.health();
    expect(health.enabled).toBe(true);
    expect(health.reachable).toBe(true);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
