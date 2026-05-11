import {
  type ChildProcessWithoutNullStreams,
  execFile,
  spawn,
} from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  type CommandRunInput,
  CommandRunInputSchema,
  type CommandRunOutput,
  CommandRunOutputSchema,
} from '@review-agent/review-types';

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = resolve(packageRoot, '../..');
const binaryName =
  process.platform === 'win32' ? 'review-runner.exe' : 'review-runner';
const packagedBinary = join(packageRoot, 'dist', 'bin', binaryName);
const targetDir = process.env.CARGO_TARGET_DIR
  ? resolve(repoRoot, process.env.CARGO_TARGET_DIR)
  : join(repoRoot, 'target');
const buildTimeoutMs = parsePositiveIntegerEnv(
  'REVIEW_AGENT_RUNNER_BUILD_TIMEOUT_MS',
  120_000
);
const defaultCommandTimeoutMs = 5 * 60_000;
const minimumHelperTimeoutMs = parsePositiveIntegerEnv(
  'REVIEW_AGENT_RUNNER_HELPER_TIMEOUT_MS',
  30_000
);
const helperTimeoutPaddingMs = parsePositiveIntegerEnv(
  'REVIEW_AGENT_RUNNER_HELPER_TIMEOUT_PADDING_MS',
  10_000
);
const maxStdoutBytes = parsePositiveIntegerEnv(
  'REVIEW_AGENT_RUNNER_HELPER_MAX_STDOUT_BYTES',
  64 * 1024 * 1024
);
const maxStderrBytes = parsePositiveIntegerEnv(
  'REVIEW_AGENT_RUNNER_HELPER_MAX_STDERR_BYTES',
  1024 * 1024
);
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
] as const;

export type CommandRunOptions = {
  signal?: AbortSignal;
};

let buildPromise: Promise<string> | undefined;

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function helperEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of helperEnvAllowlist) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

async function canExecute(path: string): Promise<boolean> {
  try {
    await access(
      path,
      process.platform === 'win32' ? constants.F_OK : constants.X_OK
    );
    return true;
  } catch {
    return false;
  }
}

async function buildReviewRunnerBinary(): Promise<string> {
  await execFileAsync(
    'cargo',
    ['build', '--quiet', '--locked', '-p', 'review-runner'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: helperEnv(),
      timeout: buildTimeoutMs,
    }
  );
  return join(targetDir, 'debug', binaryName);
}

async function resolveReviewRunnerBinary(): Promise<string> {
  const configuredBinary = process.env.REVIEW_AGENT_RUNNER_BIN;
  const candidates = [
    ...(configuredBinary ? [resolve(configuredBinary)] : []),
    packagedBinary,
    join(targetDir, 'debug', binaryName),
    join(targetDir, 'release', binaryName),
  ];
  for (const candidate of candidates) {
    if (await canExecute(candidate)) {
      return candidate;
    }
  }

  if (process.env.REVIEW_AGENT_RUNNER_ALLOW_BUILD === '1') {
    const builtBinary = await buildReviewRunnerBinary();
    if (await canExecute(builtBinary)) {
      return builtBinary;
    }
  }

  throw new Error(
    'Review runner helper binary was not found. Run `pnpm --filter @review-agent/review-runner build:rust`, set REVIEW_AGENT_RUNNER_BIN, or set REVIEW_AGENT_RUNNER_ALLOW_BUILD=1 for a development-only build fallback.'
  );
}

/**
 * Resolves the packaged Rust runner helper for the current Node process.
 *
 * @returns Absolute path to the helper binary.
 */
export async function ensureReviewRunnerBinary(): Promise<string> {
  buildPromise ??= resolveReviewRunnerBinary().catch((error: unknown) => {
    buildPromise = undefined;
    throw error;
  });
  return buildPromise;
}

async function runWithStdin(
  command: string,
  args: string[],
  input: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const child = spawn(command, args, {
      cwd: repoRoot,
      detached: process.platform !== 'win32',
      env: helperEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let externallyAborted = false;
    let outputLimitError: Error | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let terminationRequested = false;
    const terminate = (signal: NodeJS.Signals = 'SIGTERM') => {
      if (terminationRequested && signal !== 'SIGKILL') {
        return;
      }
      terminationRequested = true;
      signalChild(child, signal);
      if (signal !== 'SIGKILL') {
        forceKillTimer ??= setTimeout(() => {
          signalChild(child, 'SIGKILL');
        }, 1000);
        forceKillTimer.unref();
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const abortListener = () => {
      externallyAborted = true;
      terminate();
    };
    signal?.addEventListener('abort', abortListener, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      signal?.removeEventListener('abort', abortListener);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (outputLimitError) {
        return;
      }
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      if (stdoutBytes + chunkBytes > maxStdoutBytes) {
        outputLimitError = new Error(
          `${command} ${args.join(' ')} exceeded stdout limit ${maxStdoutBytes} bytes`
        );
        terminate();
        return;
      }
      stdout += chunk;
      stdoutBytes += chunkBytes;
    });
    child.stderr.on('data', (chunk) => {
      if (outputLimitError) {
        return;
      }
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      if (stderrBytes + chunkBytes > maxStderrBytes) {
        outputLimitError = new Error(
          `${command} ${args.join(' ')} exceeded stderr limit ${maxStderrBytes} bytes`
        );
        terminate();
        return;
      }
      stderr += chunk;
      stderrBytes += chunkBytes;
    });
    child.on('error', (error) => {
      cleanup();
      reject(error);
    });
    child.on('close', (code, exitSignal) => {
      cleanup();
      if (timedOut) {
        reject(
          new Error(
            `${command} ${args.join(' ')} timed out after ${timeoutMs}ms`
          )
        );
        return;
      }
      if (outputLimitError) {
        reject(outputLimitError);
        return;
      }
      if (externallyAborted) {
        reject(abortError(signal));
        return;
      }
      if (code === 0) {
        resolveOutput(stdout);
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} failed with ${exitSignal ?? code}: ${stderr.trim()}`
        )
      );
    });
    child.stdin.end(input);
  });
}

function abortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error('command run aborted');
  error.name = 'AbortError';
  return error;
}

function signalChild(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals
): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child signal if the process group is gone.
    }
  }
  child.kill(signal);
}

/**
 * Runs a bounded command through the Rust process-group runner.
 *
 * @param input Command request validated against the shared review-types contract.
 * @returns Structured command result with redacted output and command events.
 */
export async function runCommand(
  input: CommandRunInput,
  options: CommandRunOptions = {}
): Promise<CommandRunOutput> {
  if (options.signal?.aborted) {
    throw abortError(options.signal);
  }
  const request = CommandRunInputSchema.parse(input);
  const binary = await ensureReviewRunnerBinary();
  const helperTimeoutMs = Math.max(
    minimumHelperTimeoutMs,
    (request.timeoutMs ?? defaultCommandTimeoutMs) + helperTimeoutPaddingMs
  );
  const stdout = await runWithStdin(
    binary,
    ['run'],
    JSON.stringify(request),
    helperTimeoutMs,
    options.signal
  );
  return CommandRunOutputSchema.parse(JSON.parse(stdout));
}
