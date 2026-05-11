import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  computeExitCode,
  InvalidFindingLocationError,
  runReview,
  UnsupportedRemoteSandboxTargetError,
} from './index.js';
import { makeProvider, makeRepo } from './test-helpers.js';

describe('runReview', () => {
  it('runs and emits artifacts', async () => {
    const repo = await makeRepo();
    try {
      const raw = {
        findings: [
          {
            title: '[P1] Value constant changed without tests',
            body: 'This change modifies behavior and should include a test update.',
            confidence_score: 0.9,
            priority: 1,
            code_location: {
              absolute_file_path: join(repo.cwd, 'file.ts'),
              line_range: { start: 1, end: 1 },
            },
          },
        ],
        overall_correctness: 'patch is incorrect',
        overall_explanation: 'A likely regression exists.',
        overall_confidence_score: 0.85,
      };

      const review = await runReview(
        {
          cwd: repo.cwd,
          target: { type: 'uncommittedChanges' },
          provider: 'codexDelegate',
          outputFormats: ['json', 'sarif', 'markdown'],
        },
        {
          providers: {
            codexDelegate: makeProvider(raw, 'codexDelegate'),
            openaiCompatible: makeProvider(raw, 'openaiCompatible'),
          },
        }
      );

      expect(review.result.findings).toHaveLength(1);
      expect(review.artifacts.json).toContain('overallCorrectness');
      expect(review.artifacts.sarif).toContain('"runs"');
      expect(review.artifacts.markdown).toContain('# Review Report');
      expect(computeExitCode(review.result, 'p1')).toBe(1);
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects findings outside changed lines', async () => {
    const repo = await makeRepo();
    try {
      const raw = {
        findings: [
          {
            title: '[P1] Bad location',
            body: 'Outside changed lines.',
            confidence_score: 0.8,
            priority: 1,
            code_location: {
              absolute_file_path: join(repo.cwd, 'file.ts'),
              line_range: { start: 99, end: 99 },
            },
          },
        ],
        overall_correctness: 'patch is incorrect',
        overall_explanation: 'Bad.',
        overall_confidence_score: 0.8,
      };

      await expect(
        runReview(
          {
            cwd: repo.cwd,
            target: { type: 'uncommittedChanges' },
            provider: 'codexDelegate',
            outputFormats: ['json'],
          },
          {
            providers: {
              codexDelegate: makeProvider(raw, 'codexDelegate'),
              openaiCompatible: makeProvider(raw, 'openaiCompatible'),
            },
          }
        )
      ).rejects.toBeInstanceOf(InvalidFindingLocationError);
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects findings from excluded paths after diff filtering', async () => {
    const repo = await makeRepo();
    try {
      await writeFile(
        join(repo.cwd, 'excluded.ts'),
        'export const value = 3;\n',
        'utf8'
      );

      const raw = {
        findings: [
          {
            title: '[P1] Bad location',
            body: 'Outside filtered scope.',
            confidence_score: 0.8,
            priority: 1,
            code_location: {
              absolute_file_path: join(repo.cwd, 'excluded.ts'),
              line_range: { start: 1, end: 1 },
            },
          },
        ],
        overall_correctness: 'patch is incorrect',
        overall_explanation: 'Bad.',
        overall_confidence_score: 0.8,
      };

      await expect(
        runReview(
          {
            cwd: repo.cwd,
            target: { type: 'uncommittedChanges' },
            provider: 'codexDelegate',
            outputFormats: ['json'],
            includePaths: ['file.ts'],
          },
          {
            providers: {
              codexDelegate: makeProvider(raw, 'codexDelegate'),
              openaiCompatible: makeProvider(raw, 'openaiCompatible'),
            },
          }
        )
      ).rejects.toBeInstanceOf(InvalidFindingLocationError);
    } finally {
      await repo.cleanup();
    }
  });

  it('runs remote sandbox mode through the configured sandbox runner', async () => {
    const repo = await makeRepo();
    try {
      const providerRun = vi.fn();
      const provider = {
        ...makeProvider({}, 'codexDelegate'),
        run: providerRun,
      };
      const review = await runReview(
        {
          cwd: repo.cwd,
          target: { type: 'custom', instructions: 'remote sandbox check' },
          provider: 'codexDelegate',
          executionMode: 'remoteSandbox',
          outputFormats: ['json'],
        },
        {
          providers: {
            codexDelegate: provider,
            openaiCompatible: makeProvider({}, 'openaiCompatible'),
          },
          sandboxRunner: async (input) => {
            expect(input.resolvedPrompt).toBe('remote sandbox check');
            expect(input.normalizedDiffChunks).toHaveLength(0);
            return {
              raw: {
                findings: [],
                overall_correctness: 'patch is correct',
                overall_explanation: 'sandbox ok',
                overall_confidence_score: 1,
              },
              text: 'sandbox ok',
              resolvedModel: 'remoteSandbox:test',
              sandboxAudit: {
                sandboxId: 'sbx-core-test',
                policy: {
                  networkProfile: 'deny_all',
                  allowlistDomains: [],
                  commandAllowlistSize: 1,
                  envAllowlistSize: 1,
                },
                consumed: {
                  commandCount: 1,
                  wallTimeMs: 1,
                  outputBytes: 1,
                  artifactBytes: 1,
                },
                redactions: { apiKeyLike: 0, bearer: 0 },
                commands: [],
              },
            };
          },
        }
      );

      expect(providerRun).not.toHaveBeenCalled();
      expect(review.sandboxAudit?.sandboxId).toBe('sbx-core-test');
      expect(review.result.metadata.sandboxId).toBe('sbx-core-test');
    } finally {
      await repo.cleanup();
    }
  });

  it('fails remote sandbox mode without a sandbox runner', async () => {
    const repo = await makeRepo();
    try {
      await expect(
        runReview(
          {
            cwd: repo.cwd,
            target: { type: 'custom', instructions: 'remote sandbox check' },
            provider: 'codexDelegate',
            executionMode: 'remoteSandbox',
            outputFormats: ['json'],
          },
          {
            providers: {
              codexDelegate: makeProvider({}, 'codexDelegate'),
              openaiCompatible: makeProvider({}, 'openaiCompatible'),
            },
          }
        )
      ).rejects.toThrow('requires a configured sandbox runner');
    } finally {
      await repo.cleanup();
    }
  });

  it('rejects git-backed remote sandbox targets before host diff collection', async () => {
    const repo = await makeRepo();
    try {
      const sandboxRunner = vi.fn();
      await expect(
        runReview(
          {
            cwd: repo.cwd,
            target: { type: 'uncommittedChanges' },
            provider: 'codexDelegate',
            executionMode: 'remoteSandbox',
            outputFormats: ['json'],
          },
          {
            providers: {
              codexDelegate: makeProvider({}, 'codexDelegate'),
              openaiCompatible: makeProvider({}, 'openaiCompatible'),
            },
            sandboxRunner,
          }
        )
      ).rejects.toBeInstanceOf(UnsupportedRemoteSandboxTargetError);
      expect(sandboxRunner).not.toHaveBeenCalled();
    } finally {
      await repo.cleanup();
    }
  });
});
