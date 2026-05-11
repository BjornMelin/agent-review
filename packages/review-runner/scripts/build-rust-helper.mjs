import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const binaryName =
  process.platform === 'win32' ? 'review-runner.exe' : 'review-runner';
const targetDir = process.env.CARGO_TARGET_DIR
  ? resolve(repoRoot, process.env.CARGO_TARGET_DIR)
  : join(repoRoot, 'target');
const sourceBinary = join(targetDir, 'debug', binaryName);
const packagedBinary = join(packageRoot, 'dist', 'bin', binaryName);
const helperEnvAllowlist = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'CARGO_TARGET_DIR',
  'RUSTC_WRAPPER',
  'RUSTFLAGS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
];

function helperEnv() {
  const env = {};
  for (const key of helperEnvAllowlist) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

function runCargoBuild() {
  return new Promise((resolveBuild, reject) => {
    const child = spawn(
      'cargo',
      ['build', '--quiet', '--locked', '-p', 'review-runner'],
      {
        cwd: repoRoot,
        env: helperEnv(),
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
  const tempBinary = `${packagedBinary}.${process.pid}.${Date.now()}.tmp`;
  await copyFile(sourceBinary, tempBinary);
  if (process.platform !== 'win32') {
    const sourceMode = (await stat(sourceBinary)).mode;
    await chmod(tempBinary, sourceMode | 0o755);
  }
  try {
    await rename(tempBinary, packagedBinary);
  } catch (error) {
    await rm(tempBinary, { force: true });
    throw error;
  }
}

try {
  await runCargoBuild();
  await copyPackagedBinary();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
