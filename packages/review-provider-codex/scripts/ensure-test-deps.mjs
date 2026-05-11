import { spawn } from 'node:child_process';
import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const reviewTypesDist = join(
  packageRoot,
  '..',
  'review-types',
  'dist',
  'index.js'
);
const reviewRunnerDist = join(
  packageRoot,
  '..',
  'review-runner',
  'dist',
  'index.js'
);
const reviewTypesBuildInfo = join(
  packageRoot,
  '..',
  'review-types',
  'tsconfig.tsbuildinfo'
);
const reviewRunnerBuildInfo = join(
  packageRoot,
  '..',
  'review-runner',
  'tsconfig.tsbuildinfo'
);
const reviewRunnerEnsureHelper = join(
  packageRoot,
  '..',
  'review-runner',
  'scripts',
  'ensure-rust-helper.mjs'
);
const envAllowlist = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'PNPM_HOME',
  'COREPACK_HOME',
  'NPM_CONFIG_CACHE',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
];

function testBuildEnv() {
  const env = {};
  for (const key of envAllowlist) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

function runPnpm(args) {
  return new Promise((resolveBuild, reject) => {
    const child = spawn('pnpm', args, {
      cwd: repoRoot,
      env: testBuildEnv(),
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`pnpm ${args.join(' ')} terminated by ${signal}`));
        return;
      }
      if (code === 0) {
        resolveBuild();
        return;
      }
      reject(new Error(`pnpm ${args.join(' ')} exited with ${code ?? 1}`));
    });
  });
}

async function ensureDist(path, buildArgs) {
  try {
    await access(path);
  } catch {
    if (path === reviewTypesDist) {
      await rm(reviewTypesBuildInfo, { force: true });
    }
    if (path === reviewRunnerDist) {
      await rm(reviewRunnerBuildInfo, { force: true });
    }
    await runPnpm(buildArgs);
  }
}

await ensureDist(reviewTypesDist, [
  '--filter',
  '@review-agent/review-types',
  'build',
]);
await ensureDist(reviewRunnerDist, [
  '--filter',
  '@review-agent/review-runner',
  'build',
]);
await import(pathToFileURL(reviewRunnerEnsureHelper).href);
