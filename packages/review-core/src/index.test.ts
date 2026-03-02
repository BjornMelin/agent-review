import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ProviderDiagnostic,
  ReviewProvider,
} from '@review-agent/review-types';
import { describe, expect, it } from 'vitest';
import {
  InvalidFindingLocationError,
  computeExitCode,
  runDoctorChecks,
  runReview,
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
            codexDelegate: makeProvider('codexDelegate', raw),
            openaiCompatible: makeProvider('openaiCompatible', raw),
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
              codexDelegate: makeProvider('codexDelegate', raw),
              openaiCompatible: makeProvider('openaiCompatible', raw),
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
              codexDelegate: makeProvider('codexDelegate', raw),
              openaiCompatible: makeProvider('openaiCompatible', raw),
            },
          }
        )
      ).rejects.toBeInstanceOf(InvalidFindingLocationError);
    } finally {
      await repo.cleanup();
    }
  });

  it('continues doctor checks when one provider throws', async () => {
    const throwingProvider: ReviewProvider = {
      id: 'codexDelegate',
      capabilities: () => ({
        jsonSchemaOutput: true,
        reasoningControl: false,
        streaming: false,
      }),
      doctor: async () => {
        throw new Error('doctor failure');
      },
      run: async () => ({ raw: null, text: '' }),
    };

    const healthyProvider: ReviewProvider = {
      id: 'openaiCompatible',
      capabilities: () => ({
        jsonSchemaOutput: true,
        reasoningControl: false,
        streaming: false,
      }),
      doctor: async () => [
        {
          code: 'provider_unavailable',
          ok: true,
          severity: 'info',
          detail: 'openai available',
        } satisfies ProviderDiagnostic,
      ],
      run: async () => ({ raw: null, text: '' }),
    };

    const checks = await runDoctorChecks({
      codexDelegate: throwingProvider,
      openaiCompatible: healthyProvider,
    });

    const keys = checks.map((check) => check.name);
    expect(keys).toContain('provider.codexDelegate.doctor');
    expect(keys).toContain('provider.openaiCompatible.provider_unavailable');
    const doctorFailure = checks.find(
      (check) => check.name === 'provider.codexDelegate.doctor'
    );
    expect(doctorFailure?.ok).toBe(false);
    expect(doctorFailure?.detail).toContain('doctor failure');
  });
});
