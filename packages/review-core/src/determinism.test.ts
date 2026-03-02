import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runReview } from './index.js';
import { makeProvider, makeRepo } from './test-helpers.js';

function makeDeterministicProvider(
  repoPath: string
): ReturnType<typeof makeProvider> {
  return makeProvider('codexDelegate', {
    findings: [
      {
        title: '[P1] Value constant changed without tests',
        body: 'This change modifies behavior and should include a test update.',
        confidence_score: 0.9,
        priority: 1,
        code_location: {
          absolute_file_path: join(repoPath, 'file.ts'),
          line_range: { start: 1, end: 1 },
        },
      },
    ],
    overall_correctness: 'patch is incorrect',
    overall_explanation: 'A likely regression exists.',
    overall_confidence_score: 0.85,
  });
}

describe('core determinism and lifecycle metadata', () => {
  it('produces deterministic fingerprints and artifacts', async () => {
    const repo = await makeRepo();
    try {
      const provider = makeDeterministicProvider(repo.cwd);
      const providers = {
        codexDelegate: provider,
        openaiCompatible: provider,
      };

      const first = await runReview(
        {
          cwd: repo.cwd,
          target: { type: 'uncommittedChanges' },
          provider: 'codexDelegate',
          outputFormats: ['json', 'sarif', 'markdown'],
          model: 'fixed-model',
        },
        { providers }
      );
      const second = await runReview(
        {
          cwd: repo.cwd,
          target: { type: 'uncommittedChanges' },
          provider: 'codexDelegate',
          outputFormats: ['json', 'sarif', 'markdown'],
          model: 'fixed-model',
        },
        { providers }
      );

      expect(first.result.findings[0]?.fingerprint).toBe(
        second.result.findings[0]?.fingerprint
      );
      expect(first.artifacts.json).toBe(second.artifacts.json);
      expect(first.artifacts.sarif).toBe(second.artifacts.sarif);
      expect(first.artifacts.markdown).toBe(second.artifacts.markdown);
    } finally {
      await repo.cleanup();
    }
  });

  it('emits correlation metadata on every lifecycle event', async () => {
    const repo = await makeRepo();
    try {
      const provider = makeDeterministicProvider(repo.cwd);
      const providers = {
        codexDelegate: provider,
        openaiCompatible: provider,
      };

      const events: Parameters<
        NonNullable<Parameters<typeof runReview>[1]['onEvent']>
      >[0][] = [];
      await runReview(
        {
          cwd: repo.cwd,
          target: { type: 'uncommittedChanges' },
          provider: 'codexDelegate',
          outputFormats: ['json'],
        },
        {
          providers,
          onEvent: (event) => events.push(event),
        }
      );

      expect(events.length).toBeGreaterThan(0);
      const reviewId = events[0]?.meta.correlation.reviewId;
      expect(reviewId).toBeTruthy();
      for (const event of events) {
        expect(event.meta.eventId.length).toBeGreaterThan(0);
        expect(event.meta.timestampMs).toBeGreaterThan(0);
        expect(event.meta.correlation.reviewId).toBe(reviewId);
      }
    } finally {
      await repo.cleanup();
    }
  });

  it('keeps mirror-write failures non-blocking', async () => {
    const repo = await makeRepo();
    try {
      const provider = makeDeterministicProvider(repo.cwd);
      const providers = {
        codexDelegate: provider,
        openaiCompatible: provider,
      };

      const result = await runReview(
        {
          cwd: repo.cwd,
          target: { type: 'uncommittedChanges' },
          provider: 'codexDelegate',
          outputFormats: ['json'],
        },
        { providers },
        {
          mirrorWrite: async () => {
            throw new Error('bridge unavailable');
          },
        }
      );

      expect(result.result.findings).toHaveLength(1);
      expect(result.artifacts.json).toContain('overallCorrectness');
    } finally {
      await repo.cleanup();
    }
  });
});
