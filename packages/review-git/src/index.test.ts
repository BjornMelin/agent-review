import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { collectDiffForTarget, mergeBaseWithHead } from './index.js';

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

describe('collectDiffForTarget', () => {
  it('disables external diff helpers for host-side diff collection', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'review-git-test-'));
    try {
      await runGit(cwd, ['init', '--initial-branch=main']);
      await runGit(cwd, ['config', 'user.name', 'Tester']);
      await runGit(cwd, ['config', 'user.email', 'tester@example.com']);

      await writeFile(join(cwd, 'file.txt'), 'base\n');
      await runGit(cwd, ['add', 'file.txt']);
      await runGit(cwd, ['commit', '-m', 'base']);
      await writeFile(join(cwd, 'file.txt'), 'changed\n');

      const marker = join(cwd, 'external-diff-ran');
      const helper = join(cwd, 'external-diff.sh');
      await writeFile(
        helper,
        `#!/bin/sh\necho helper-ran > ${JSON.stringify(marker)}\nexit 1\n`
      );
      await chmod(helper, 0o755);
      await runGit(cwd, ['config', 'diff.external', helper]);

      const diff = await collectDiffForTarget(cwd, {
        type: 'uncommittedChanges',
      });

      expect(diff.patch).toContain('+changed');
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves untracked symlinks without reading target file contents', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'review-git-test-'));
    const outside = await mkdtemp(join(tmpdir(), 'review-git-secret-'));
    try {
      await runGit(cwd, ['init', '--initial-branch=main']);
      await runGit(cwd, ['config', 'user.name', 'Tester']);
      await runGit(cwd, ['config', 'user.email', 'tester@example.com']);
      await writeFile(join(cwd, 'tracked.txt'), 'base\n');
      await runGit(cwd, ['add', 'tracked.txt']);
      await runGit(cwd, ['commit', '-m', 'base']);

      const secretPath = join(outside, 'secret.txt');
      await writeFile(secretPath, 'DO_NOT_LEAK_THIS_CONTENT\n');
      await symlink(secretPath, join(cwd, 'linked-secret'));

      const diff = await collectDiffForTarget(cwd, {
        type: 'uncommittedChanges',
      });

      expect(diff.patch).toContain('new file mode 120000');
      expect(diff.patch).toContain('+');
      expect(diff.patch).not.toContain('DO_NOT_LEAK_THIS_CONTENT');
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('collects untracked files when cwd is a symlink to the repo root', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'review-git-test-'));
    const linkParent = await mkdtemp(join(tmpdir(), 'review-git-link-'));
    const linkedCwd = join(linkParent, 'repo-link');
    try {
      await runGit(repo, ['init', '--initial-branch=main']);
      await runGit(repo, ['config', 'user.name', 'Tester']);
      await runGit(repo, ['config', 'user.email', 'tester@example.com']);
      await writeFile(join(repo, 'tracked.txt'), 'base\n');
      await runGit(repo, ['add', 'tracked.txt']);
      await runGit(repo, ['commit', '-m', 'base']);
      await writeFile(join(repo, 'untracked.txt'), 'visible\n');
      await symlink(repo, linkedCwd);

      const diff = await collectDiffForTarget(linkedCwd, {
        type: 'uncommittedChanges',
      });

      expect(diff.patch).toContain('+++ b/untracked.txt');
      expect(diff.patch).toContain('+visible');
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(linkParent, { recursive: true, force: true });
    }
  });
});
