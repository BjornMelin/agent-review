import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ensureReviewRunnerBinary, runCommand } from '../src/index.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const binaryName =
  process.platform === 'win32' ? 'review-runner.exe' : 'review-runner';

describe('review runner adapter', () => {
  it('resolves the packaged Rust helper from the dist artifact', async () => {
    await expect(ensureReviewRunnerBinary()).resolves.toBe(
      join(packageRoot, 'dist', 'bin', binaryName)
    );
  });

  it('runs commands through the Rust process-group helper', async () => {
    const result = await runCommand({
      commandId: 'adapter-smoke',
      cmd: 'node',
      args: ['-e', 'process.stdout.write("ok")'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
      readFiles: [],
    });

    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
    expect(result.events.some((event) => event.type === 'started')).toBe(true);
  });

  it('does not inherit parent environment into delegated commands', async () => {
    process.env.REVIEW_RUNNER_SECRET_FOR_TEST = 'leaked';
    try {
      const result = await runCommand({
        commandId: 'adapter-env-smoke',
        cmd: 'node',
        args: [
          '-e',
          'process.stdout.write(process.env.REVIEW_RUNNER_SECRET_FOR_TEST ?? "")',
        ],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '' },
        readFiles: [],
      });

      expect(result.status).toBe('completed');
      expect(result.stdout).toBe('');
    } finally {
      delete process.env.REVIEW_RUNNER_SECRET_FOR_TEST;
    }
  });
});
