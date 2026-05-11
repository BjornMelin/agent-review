import { spawn } from 'node:child_process';

const child = spawn(
  'vitest',
  ['run', 'src/diff-corpus.test.ts', 'src/performance.test.ts'],
  {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      REVIEW_AGENT_RUST_DIFF_BENCH: '1',
      REVIEW_AGENT_STRICT_PERF: '1',
    },
    shell: process.platform === 'win32',
    stdio: 'inherit',
  }
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
