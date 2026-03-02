import type { ReviewResult } from '@review-agent/review-types';
import { describe, expect, it } from 'vitest';
import {
  renderJson,
  renderMarkdown,
  renderSarifJson,
  sortFindingsDeterministically,
} from './index.js';

const baseResult: ReviewResult = {
  findings: [
    {
      title: '[P2] Later issue',
      body: 'later body',
      priority: 2,
      confidenceScore: 0.8,
      codeLocation: {
        absoluteFilePath: '/repo/b.ts',
        lineRange: { start: 2, end: 2 },
      },
      fingerprint: 'bbb',
    },
    {
      title: '[P1] Early issue',
      body: 'early body',
      priority: 1,
      confidenceScore: 0.9,
      codeLocation: {
        absoluteFilePath: '/repo/a.ts',
        lineRange: { start: 1, end: 1 },
      },
      fingerprint: 'aaa',
    },
  ],
  overallCorrectness: 'patch is incorrect',
  overallExplanation: 'Issues found.',
  overallConfidenceScore: 0.95,
  metadata: {
    provider: 'codexDelegate',
    modelResolved: 'model',
    executionMode: 'localTrusted',
    promptPack: 'pack',
    gitContext: {
      mode: 'uncommitted',
    },
  },
};

describe('artifact determinism', () => {
  it('sorts findings deterministically', () => {
    const sorted = sortFindingsDeterministically(baseResult.findings);
    expect(sorted.map((item) => item.fingerprint)).toEqual(['aaa', 'bbb']);
  });

  it('renders deterministic json/markdown/sarif output', () => {
    const firstJson = renderJson(baseResult);
    const secondJson = renderJson({
      ...baseResult,
      findings: [...baseResult.findings].reverse(),
    });
    expect(secondJson).toBe(firstJson);

    const firstMarkdown = renderMarkdown(baseResult);
    const secondMarkdown = renderMarkdown({
      ...baseResult,
      findings: [...baseResult.findings].reverse(),
    });
    expect(secondMarkdown).toBe(firstMarkdown);

    const firstSarif = renderSarifJson(baseResult);
    const secondSarif = renderSarifJson({
      ...baseResult,
      findings: [...baseResult.findings].reverse(),
    });
    expect(secondSarif).toBe(firstSarif);
  });

  it('deduplicates SARIF rules when findings share rule IDs', () => {
    const duplicateTitleResult = {
      ...baseResult,
      findings: [
        {
          title: '[P2] Shared title',
          body: 'first body',
          priority: 2 as const,
          confidenceScore: 0.8,
          codeLocation: {
            absoluteFilePath: '/repo/a.ts',
            lineRange: { start: 1, end: 1 },
          },
          fingerprint: 'finger1',
        },
        {
          title: '[P1] Shared title',
          body: 'second body',
          priority: 1 as const,
          confidenceScore: 0.9,
          codeLocation: {
            absoluteFilePath: '/repo/b.ts',
            lineRange: { start: 2, end: 2 },
          },
          fingerprint: 'finger2',
        },
      ],
    };

    const sarif = JSON.parse(renderSarifJson(duplicateTitleResult));
    const rules = sarif.runs[0].tool.driver.rules;
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('shared-title');
  });

  it('renders markdown with a single priority prefix', () => {
    const prefixedTitleResult = {
      ...baseResult,
      findings: [
        {
          title: '[P2] Already prefixed',
          body: 'details',
          priority: 2 as const,
          confidenceScore: 0.8,
          codeLocation: {
            absoluteFilePath: '/repo/a.ts',
            lineRange: { start: 1, end: 1 },
          },
          fingerprint: 'finger3',
        },
      ],
    };

    const markdown = renderMarkdown(prefixedTitleResult);
    expect(markdown).toContain('### [P2] Already prefixed');
    expect(markdown).not.toContain('### [P2] [P2] Already prefixed');
  });
});
