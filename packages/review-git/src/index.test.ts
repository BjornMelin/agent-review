import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { mergeBaseWithHead } from './index.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  return stdout.trim();
}

describe('mergeBaseWithHead', () => {
  it('returns merge base with local branch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'review-git-test-'));
    try {
      await runGit(cwd, ['init', '--initial-branch=main']);
      await runGit(cwd, ['config', 'user.name', 'Tester']);
      await runGit(cwd, ['config', 'user.email', 'tester@example.com']);

      await writeFile(join(cwd, 'base.txt'), 'base\n');
      await runGit(cwd, ['add', 'base.txt']);
      await runGit(cwd, ['commit', '-m', 'base']);

      await runGit(cwd, ['checkout', '-b', 'feature']);
      await writeFile(join(cwd, 'feature.txt'), 'feature\n');
      await runGit(cwd, ['add', 'feature.txt']);
      await runGit(cwd, ['commit', '-m', 'feature']);

      await runGit(cwd, ['checkout', 'main']);
      await writeFile(join(cwd, 'main.txt'), 'main\n');
      await runGit(cwd, ['add', 'main.txt']);
      await runGit(cwd, ['commit', '-m', 'main']);
      await runGit(cwd, ['checkout', 'feature']);

      const expected = await runGit(cwd, ['merge-base', 'HEAD', 'main']);
      const actual = await mergeBaseWithHead(cwd, 'main');
      expect(actual).toBe(expected);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
