import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const binaryName =
  process.platform === 'win32' ? 'review-git-diff.exe' : 'review-git-diff';
const targetDir = process.env.CARGO_TARGET_DIR
  ? resolve(repoRoot, process.env.CARGO_TARGET_DIR)
  : join(repoRoot, 'target');
const sourceBinary = join(targetDir, 'debug', binaryName);
const packagedBinary = join(packageRoot, 'dist', 'bin', binaryName);

function runCargoBuild() {
  return new Promise((resolveBuild, reject) => {
    const child = spawn(
      'cargo',
      ['build', '--quiet', '--locked', '-p', 'review-git-diff'],
      {
        cwd: repoRoot,
        shell: process.platform === 'win32',
        stdio: 'inherit',
      }
    );

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`cargo build terminated by ${signal}`));
        return;
      }
      if (code === 0) {
        resolveBuild();
        return;
      }
      reject(new Error(`cargo build exited with ${code ?? 1}`));
    });
  });
}

async function copyPackagedBinary() {
  await mkdir(join(packageRoot, 'dist', 'bin'), { recursive: true });
  await copyFile(sourceBinary, packagedBinary);
  if (process.platform !== 'win32') {
    const sourceMode = (await stat(sourceBinary)).mode;
    await chmod(packagedBinary, sourceMode | 0o755);
  }
}

try {
  await runCargoBuild();
  await copyPackagedBinary();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
