import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ReviewProvider } from '@review-agent/review-types';

const execFileAsync = promisify(execFile);

export async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

export async function makeRepo(): Promise<{
  cwd: string;
  cleanup: () => Promise<void>;
}> {
  let cwd: string | undefined;
  try {
    cwd = await mkdtemp(join(tmpdir(), 'review-core-test-'));
    await runGit(cwd, ['init', '--initial-branch=main']);
    await runGit(cwd, ['config', 'user.name', 'Tester']);
    await runGit(cwd, ['config', 'user.email', 'tester@example.com']);
    await writeFile(join(cwd, 'file.ts'), 'export const value = 1;\n', 'utf8');
    await runGit(cwd, ['add', 'file.ts']);
    await runGit(cwd, ['commit', '-m', 'base']);
    await writeFile(join(cwd, 'file.ts'), 'export const value = 2;\n', 'utf8');
    const repoPath = cwd;

    return {
      cwd: repoPath,
      cleanup: async () => {
        await rm(repoPath, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (cwd) {
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

export function makeProvider(
  id: ReviewProvider['id'],
  raw: unknown
): ReviewProvider {
  return {
    id,
    capabilities: () => ({
      jsonSchemaOutput: true,
      reasoningControl: false,
      streaming: false,
    }),
    run: async () => ({ raw, text: JSON.stringify(raw) }),
  };
}
