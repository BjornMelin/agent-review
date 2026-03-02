import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { collectDiffForTarget } from './index.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, encoding: 'utf8' });
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
});
