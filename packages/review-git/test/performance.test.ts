import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../src/diff-parser.js';
import { buildChangedLineIndex, collectDiffForTarget } from '../src/index.js';
import {
  ensureRustDiffBinary,
  parseWithRustDiffCandidate,
} from '../test-support/rust-diff-candidate.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, encoding: 'utf8' });
}

function makeSyntheticPatch(fileCount: number): string {
  return Array.from({ length: fileCount }, (_value, index) => {
    const file = `src/file-${index}.ts`;
    return [
      `diff --git a/${file} b/${file}`,
      'index 7898192..6178079 100644',
      `--- a/${file}`,
      `+++ b/${file}`,
      '@@ -1 +1 @@',
      `-export const value${index} = "old";`,
      `+export const value${index} = "new";`,
    ].join('\n');
  }).join('\n');
}

describe('large diff performance suite', () => {
  it('collects and parses large uncommitted diffs within budget', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'review-git-performance-'));
    try {
      await runGit(cwd, ['init', '--initial-branch=main']);
      await runGit(cwd, ['config', 'user.name', 'Tester']);
      await runGit(cwd, ['config', 'user.email', 'tester@example.com']);

      const fileCount = 140;
      for (let index = 0; index < fileCount; index += 1) {
        const file = join(cwd, `file-${index}.ts`);
        await writeFile(file, `export const v${index} = 1;\n`, 'utf8');
      }
      await runGit(cwd, ['add', '.']);
      await runGit(cwd, ['commit', '-m', 'baseline']);

      for (let index = 0; index < fileCount; index += 1) {
        const file = join(cwd, `file-${index}.ts`);
        await writeFile(file, `export const v${index} = 2;\n`, 'utf8');
      }

      const startedAt = Date.now();
      const diff = await collectDiffForTarget(cwd, {
        type: 'uncommittedChanges',
      });
      const durationMs = Date.now() - startedAt;

      expect(diff.chunks.length).toBe(fileCount);
      expect(diff.changedLineIndex.size).toBe(fileCount);
      if (process.env.REVIEW_AGENT_STRICT_PERF === '1') {
        expect(durationMs).toBeLessThan(15000);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30000);

  it('benchmarks the parser/index path with an optional Rust candidate', async () => {
    const cwd = join(tmpdir(), 'review-git-benchmark-root');
    const patch = makeSyntheticPatch(240);

    const tsStartedAt = Date.now();
    const tsChunks = parseUnifiedDiff(cwd, patch);
    const tsIndex = buildChangedLineIndex(tsChunks);
    const tsDurationMs = Date.now() - tsStartedAt;

    expect(tsChunks.length).toBe(240);
    expect(tsIndex.size).toBe(240);
    if (process.env.REVIEW_AGENT_STRICT_PERF === '1') {
      expect(tsDurationMs).toBeLessThan(1500);
    }

    if (process.env.REVIEW_AGENT_RUST_DIFF_BENCH !== '1') {
      return;
    }

    await ensureRustDiffBinary();
    const rustStartedAt = Date.now();
    const rustChunks = await parseWithRustDiffCandidate(cwd, patch);
    const rustDurationMs = Date.now() - rustStartedAt;

    expect(
      rustChunks.map((chunk) => ({
        file: chunk.file,
        absoluteFilePath: chunk.absoluteFilePath,
        changedLines: chunk.changedLines,
        patch: chunk.patch,
      }))
    ).toEqual(
      tsChunks.map((chunk) => ({
        file: chunk.file,
        absoluteFilePath: chunk.absoluteFilePath,
        changedLines: chunk.changedLines,
        patch: chunk.patch,
      }))
    );
    if (process.env.REVIEW_AGENT_STRICT_PERF === '1') {
      expect(rustDurationMs).toBeLessThan(Math.max(1000, tsDurationMs * 20));
    }
  }, 60000);
});
