import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  LifecycleEvent,
  ReviewProviderRunInput,
} from '@review-agent/review-types';
import { ReviewProviderCommandRunError } from '@review-agent/review-types';
import { describe, expect, it, vi } from 'vitest';
import {
  computeExitCode,
  InvalidFindingLocationError,
  ReviewRunCancelledError,
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

  it('surfaces provider command runs with command correlation events', async () => {
    const repo = await makeRepo();
    try {
      const raw = {
        findings: [],
        overall_correctness: 'patch is correct',
        overall_explanation: 'ok',
        overall_confidence_score: 0.99,
      };
      const events: LifecycleEvent[] = [];
      const providerRun = vi.fn(async () => ({
        raw,
        text: JSON.stringify(raw),
        commandRun: {
          commandId: 'codex-review',
          cmd: 'codex',
          args: ['review', '--uncommitted'],
          cwd: repo.cwd,
          status: 'completed' as const,
          exitCode: 0,
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          startedAtMs: 1,
          endedAtMs: 2,
          durationMs: 1,
          outputBytes: 0,
          redactions: { apiKeyLike: 0, bearer: 0 },
          events: [
            {
              type: 'started' as const,
              commandId: 'codex-review',
              timestampMs: 1,
            },
            {
              type: 'exited' as const,
              commandId: 'codex-review',
              timestampMs: 2,
            },
          ],
          files: [],
        },
      }));
      const provider = {
        ...makeProvider(raw, 'codexDelegate'),
        run: providerRun,
      };

      const review = await runReview(
        {
          cwd: repo.cwd,
          target: { type: 'uncommittedChanges' },
          provider: 'codexDelegate',
          outputFormats: ['json'],
        },
        {
          providers: {
            codexDelegate: provider,
            openaiCompatible: makeProvider(raw, 'openaiCompatible'),
          },
          onEvent: (event) => {
            events.push(event);
          },
        }
      );

      expect(review.commandRuns?.[0]?.commandId).toBe('codex-review');
      expect(
        events.some(
          (event) =>
            event.type === 'progress' &&
            event.meta.correlation.commandId === 'codex-review' &&
            event.message.includes('finished with completed')
        )
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === 'progress' &&
            event.meta.correlation.commandId === 'codex-review' &&
            event.message.includes('event started')
        )
      ).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('redacts provider output, command events, and generated artifacts', async () => {
    const repo = await makeRepo();
    try {
      const secret =
        'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456 Bearer abc.def.ghi';
      const raw = {
        findings: [
          {
            title: 'Secret leak',
            body: `The provider included ${secret}`,
            confidence_score: 0.9,
            priority: 1,
            code_location: {
              absolute_file_path: join(repo.cwd, 'file.ts'),
              line_range: { start: 1, end: 1 },
            },
          },
        ],
        overall_correctness: 'patch is incorrect',
        overall_explanation: `Summary includes ${secret}`,
        overall_confidence_score: 0.9,
      };
      const events: LifecycleEvent[] = [];
      const provider = {
        ...makeProvider(raw, 'codexDelegate'),
        run: vi.fn(async () => ({
          raw,
          text: JSON.stringify(raw),
          commandRun: {
            commandId: 'codex-review',
            cmd: 'codex',
            args: ['review'],
            cwd: repo.cwd,
            status: 'completed' as const,
            exitCode: 0,
            stdout: secret,
            stderr: `stderr ${secret}`,
            stdoutTruncated: false,
            stderrTruncated: false,
            startedAtMs: 1,
            endedAtMs: 2,
            durationMs: 1,
            outputBytes: 0,
            redactions: { apiKeyLike: 0, bearer: 0 },
            events: [
              {
                type: 'exited' as const,
                commandId: 'codex-review',
                timestampMs: 2,
                message: secret,
              },
            ],
            files: [
              {
                key: 'lastMessage',
                path: 'last-message.txt',
                content: secret,
                byteLength: secret.length,
                truncated: false,
                redactions: { apiKeyLike: 0, bearer: 0 },
              },
            ],
          },
        })),
      };

      const review = await runReview(
        {
          cwd: repo.cwd,
          target: { type: 'uncommittedChanges' },
          provider: 'codexDelegate',
          outputFormats: ['json', 'markdown', 'sarif'],
        },
        {
          providers: {
            codexDelegate: provider,
            openaiCompatible: makeProvider(raw, 'openaiCompatible'),
          },
          onEvent: (event) => {
            events.push(event);
          },
        }
      );

      const serialized = JSON.stringify({ review, events });
      expect(serialized).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
      expect(serialized).not.toContain('abc.def.ghi');
      expect(serialized).toContain('[REDACTED_SECRET]');
    } finally {
      await repo.cleanup();
    }
  });

  it('enforces prompt and artifact byte budgets', async () => {
    const repo = await makeRepo();
    try {
      await expect(
        runReview(
          {
            cwd: repo.cwd,
            target: { type: 'custom', instructions: 'review this change' },
            provider: 'codexDelegate',
            outputFormats: ['json'],
          },
          {
            providers: {
              codexDelegate: makeProvider({}, 'codexDelegate'),
              openaiCompatible: makeProvider({}, 'openaiCompatible'),
            },
            limits: { maxPromptBytes: 4 },
          }
        )
      ).rejects.toThrow(/prompt/);

      const raw = {
        findings: [],
        overall_correctness: 'patch is correct',
        overall_explanation: 'x'.repeat(256),
        overall_confidence_score: 1,
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
            limits: { maxArtifactBytes: 64 },
          }
        )
      ).rejects.toThrow(/artifact/);
    } finally {
      await repo.cleanup();
    }
  });

  it('emits provider command-run telemetry before rethrowing provider failures', async () => {
    const repo = await makeRepo();
    try {
      const raw = {
        findings: [],
        overall_correctness: 'patch is correct',
        overall_explanation: 'ok',
        overall_confidence_score: 0.99,
      };
      const commandRun = {
        commandId: 'codex-review',
        cmd: 'codex',
        args: ['review', '--uncommitted'],
        cwd: repo.cwd,
        status: 'timedOut' as const,
        exitCode: null,
        stdout: '',
        stderr: 'timed out',
        stdoutTruncated: false,
        stderrTruncated: false,
        startedAtMs: 1,
        endedAtMs: 2,
        durationMs: 1,
        outputBytes: 9,
        redactions: { apiKeyLike: 0, bearer: 0 },
        events: [
          {
            type: 'timedOut' as const,
            commandId: 'codex-review',
            timestampMs: 2,
          },
        ],
        files: [],
      };
      const events: LifecycleEvent[] = [];
      const provider = {
        ...makeProvider(raw, 'codexDelegate'),
        run: vi.fn(async () => {
          throw new ReviewProviderCommandRunError(
            'codex delegate failed: timed out',
            commandRun
          );
        }),
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
              codexDelegate: provider,
              openaiCompatible: makeProvider(raw, 'openaiCompatible'),
            },
            onEvent: (event) => {
              events.push(event);
            },
          }
        )
      ).rejects.toBeInstanceOf(ReviewProviderCommandRunError);

      expect(
        events.some(
          (event) =>
            event.type === 'progress' &&
            event.meta.correlation.commandId === 'codex-review' &&
            event.message.includes('finished with timedOut')
        )
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === 'progress' &&
            event.meta.correlation.commandId === 'codex-review' &&
            event.message.includes('event timedOut')
        )
      ).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('fails before provider work when the run is already cancelled', async () => {
    const repo = await makeRepo();
    try {
      const controller = new AbortController();
      controller.abort(new Error('cancelled before provider'));
      const providerRun = vi.fn();
      const provider = {
        ...makeProvider({}, 'codexDelegate'),
        run: providerRun,
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
              codexDelegate: provider,
              openaiCompatible: makeProvider({}, 'openaiCompatible'),
            },
            signal: controller.signal,
          }
        )
      ).rejects.toBeInstanceOf(ReviewRunCancelledError);
      expect(providerRun).not.toHaveBeenCalled();
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

  it('filters provider input and changed-line indexes with production path filters', async () => {
    const repo = await makeRepo();
    try {
      await mkdir(join(repo.cwd, 'src/generated'), { recursive: true });
      await mkdir(join(repo.cwd, 'test'), { recursive: true });
      await writeFile(
        join(repo.cwd, 'src/app.ts'),
        'export const app = 2;\n',
        'utf8'
      );
      await writeFile(
        join(repo.cwd, 'src/generated/client.ts'),
        'export const generated = 2;\n',
        'utf8'
      );
      await writeFile(
        join(repo.cwd, 'test/app.test.ts'),
        'export const test = 2;\n',
        'utf8'
      );

      const raw = {
        findings: [
          {
            title: '[P1] Included location',
            body: 'Inside filtered scope.',
            confidence_score: 0.8,
            priority: 1,
            code_location: {
              absolute_file_path: join(repo.cwd, 'src/app.ts'),
              line_range: { start: 1, end: 1 },
            },
          },
        ],
        overall_correctness: 'patch is incorrect',
        overall_explanation: 'Included file is reviewable.',
        overall_confidence_score: 0.8,
      };
      const providerRun = vi.fn(async (input: ReviewProviderRunInput) => {
        expect(input.normalizedDiffChunks.map((chunk) => chunk.file)).toEqual([
          'src/app.ts',
        ]);
        expect(input.abortSignal).toBeUndefined();
        return { raw, text: JSON.stringify(raw) };
      });
      const provider = {
        ...makeProvider(raw, 'codexDelegate'),
        run: providerRun,
      };

      const review = await runReview(
        {
          cwd: repo.cwd,
          target: { type: 'uncommittedChanges' },
          provider: 'codexDelegate',
          outputFormats: ['json'],
          includePaths: ['src/**'],
          excludePaths: ['src/generated/**'],
        },
        {
          providers: {
            codexDelegate: provider,
            openaiCompatible: makeProvider(raw, 'openaiCompatible'),
          },
        }
      );

      expect(providerRun).toHaveBeenCalledTimes(1);
      expect(review.diff.chunks.map((chunk) => chunk.file)).toEqual([
        'src/app.ts',
      ]);
      expect([...review.diff.changedLineIndex.keys()]).toEqual([
        join(repo.cwd, 'src/app.ts'),
      ]);
      expect(review.result.findings).toHaveLength(1);
    } finally {
      await repo.cleanup();
    }
  });

  it('passes active cancellation signals into providers', async () => {
    const repo = await makeRepo();
    try {
      const raw = {
        findings: [],
        overall_correctness: 'patch is correct',
        overall_explanation: 'ok',
        overall_confidence_score: 1,
      };
      const controller = new AbortController();
      const providerRun = vi.fn(async (input: ReviewProviderRunInput) => {
        expect(input.abortSignal).toBe(controller.signal);
        return { raw, text: JSON.stringify(raw) };
      });
      const provider = {
        ...makeProvider(raw, 'codexDelegate'),
        run: providerRun,
      };

      await runReview(
        {
          cwd: repo.cwd,
          target: { type: 'uncommittedChanges' },
          provider: 'codexDelegate',
          outputFormats: ['json'],
        },
        {
          providers: {
            codexDelegate: provider,
            openaiCompatible: makeProvider(raw, 'openaiCompatible'),
          },
          signal: controller.signal,
        }
      );

      expect(providerRun).toHaveBeenCalledTimes(1);
    } finally {
      await repo.cleanup();
    }
  });

  it('normalizes in-flight provider aborts to review cancellation', async () => {
    const repo = await makeRepo();
    try {
      const controller = new AbortController();
      const provider = {
        ...makeProvider({}, 'codexDelegate'),
        run: vi.fn(async () => {
          controller.abort(new Error('provider aborted'));
          const error = new Error('raw abort transport error');
          error.name = 'AbortError';
          throw error;
        }),
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
              codexDelegate: provider,
              openaiCompatible: makeProvider({}, 'openaiCompatible'),
            },
            signal: controller.signal,
          }
        )
      ).rejects.toMatchObject({
        name: 'ReviewRunCancelledError',
        message: 'provider aborted',
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('normalizes provider aborts that throw the abort reason', async () => {
    const repo = await makeRepo();
    try {
      const controller = new AbortController();
      const provider = {
        ...makeProvider({}, 'codexDelegate'),
        run: vi.fn(async () => {
          controller.abort(new Error('detached review cancelled'));
          throw controller.signal.reason;
        }),
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
              codexDelegate: provider,
              openaiCompatible: makeProvider({}, 'openaiCompatible'),
            },
            signal: controller.signal,
          }
        )
      ).rejects.toMatchObject({
        name: 'ReviewRunCancelledError',
        message: 'detached review cancelled',
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('preserves provider failures that race with cancellation', async () => {
    const repo = await makeRepo();
    try {
      const controller = new AbortController();
      const provider = {
        ...makeProvider({}, 'codexDelegate'),
        run: vi.fn(async () => {
          controller.abort(new Error('client disconnected'));
          throw new Error('provider authentication failed');
        }),
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
              codexDelegate: provider,
              openaiCompatible: makeProvider({}, 'openaiCompatible'),
            },
            signal: controller.signal,
          }
        )
      ).rejects.toMatchObject({
        name: 'Error',
        message: 'provider authentication failed',
      });
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
