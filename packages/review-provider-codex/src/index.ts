import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { runCommand } from '@review-agent/review-runner';
import type {
  CommandRunOutput,
  ProviderDiagnostic,
  ReviewProvider,
  ReviewProviderCapabilities,
  ReviewProviderRunInput,
  ReviewProviderRunOutput,
  ReviewProviderValidationInput,
  ReviewTarget,
} from '@review-agent/review-types';
import { ReviewProviderCommandRunError } from '@review-agent/review-types';

const CODEX_DOCTOR_TIMEOUT_MS = 10_000;
const CODEX_REVIEW_TIMEOUT_MS = 5 * 60_000;
const CODEX_OUTPUT_BYTES = 16 * 1024 * 1024;
const LAST_MESSAGE_KEY = 'lastMessage';
const TEMP_DIR_PLACEHOLDER = '{tempDir}';
const CODEX_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'CODEX_HOME',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const;

function targetToArgs(target: ReviewTarget): string[] {
  switch (target.type) {
    case 'uncommittedChanges':
      return ['--uncommitted'];
    case 'baseBranch':
      return ['--base', target.branch];
    case 'commit': {
      const args = ['--commit', target.sha];
      if (target.title) {
        args.push('--title', target.title);
      }
      return args;
    }
    case 'custom':
      return [target.instructions];
    default:
      throw new Error(`unsupported review target: ${JSON.stringify(target)}`);
  }
}

export type CodexProviderOptions = {
  codexBin?: string;
  outputBytes?: number;
};

function commandText(output: CommandRunOutput): string {
  return (
    output.files
      .find((file) => file.key === LAST_MESSAGE_KEY)
      ?.content.trim() ||
    output.stdout.trim() ||
    output.stderr.trim()
  );
}

function codexEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CODEX_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Review provider that delegates requests to a local Codex CLI binary through the command runner.
 */
export class CodexDelegateProvider implements ReviewProvider {
  id = 'codexDelegate' as const;
  private readonly codexBin: string;
  private readonly outputBytes: number;

  constructor(options: CodexProviderOptions = {}) {
    this.codexBin = options.codexBin ?? process.env.CODEX_BIN ?? 'codex';
    this.outputBytes = options.outputBytes ?? CODEX_OUTPUT_BYTES;
  }

  capabilities(): ReviewProviderCapabilities {
    return {
      jsonSchemaOutput: false,
      reasoningControl: false,
      streaming: false,
    };
  }

  validateRequest(input: ReviewProviderValidationInput): ProviderDiagnostic[] {
    const diagnostics: ProviderDiagnostic[] = [];
    if (input.request.reasoningEffort) {
      diagnostics.push({
        code: 'unsupported_reasoning_effort',
        ok: false,
        severity: 'error',
        detail:
          'codexDelegate does not accept reasoning-effort controls for /review delegation',
        remediation: 'Omit --reasoning-effort when using --provider codex.',
      });
    }
    return diagnostics;
  }

  async doctor(): Promise<ProviderDiagnostic[]> {
    const diagnostics: ProviderDiagnostic[] = [];
    try {
      const output = await runCommand({
        commandId: 'codex-doctor',
        cmd: this.codexBin,
        args: ['--version'],
        cwd: process.cwd(),
        env: codexEnv(),
        timeoutMs: CODEX_DOCTOR_TIMEOUT_MS,
        maxStdoutBytes: 1024 * 1024,
        maxStderrBytes: 1024 * 1024,
        readFiles: [],
      });
      if (output.status === 'failedToStart') {
        diagnostics.push({
          code: 'binary_missing',
          ok: false,
          severity: 'error',
          detail: `codex binary "${this.codexBin}" was not found`,
          remediation:
            'Install Codex CLI or set CODEX_BIN to a valid executable path.',
        });
        return diagnostics;
      }
      if (output.status !== 'completed' || output.exitCode !== 0) {
        diagnostics.push({
          code: 'provider_unavailable',
          ok: false,
          severity: 'error',
          detail: `codex binary check failed: ${commandText(output) || output.status}`,
          remediation:
            'Verify codex CLI installation and executable permissions.',
        });
        return diagnostics;
      }
      diagnostics.push({
        code: 'provider_unavailable',
        ok: true,
        severity: 'info',
        detail: `codex binary is available at "${this.codexBin}"`,
      });
    } catch (error) {
      const err = error as Error;
      diagnostics.push({
        code: 'provider_unavailable',
        ok: false,
        severity: 'error',
        detail: `codex binary check failed: ${err.message}`,
        remediation:
          'Verify codex CLI installation and executable permissions.',
      });
      return diagnostics;
    }

    const hasEnvToken = Boolean(
      process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY
    );
    const authPath = resolve(homedir() ?? process.cwd(), '.codex', 'auth.json');
    const hasAuthFile = await access(authPath)
      .then(() => true)
      .catch(() => false);
    if (hasEnvToken || hasAuthFile) {
      diagnostics.push({
        code: 'auth_available',
        ok: true,
        severity: 'info',
        detail: 'codex auth signal detected (env token or ~/.codex/auth.json)',
      });
    } else {
      diagnostics.push({
        code: 'auth_missing',
        ok: false,
        severity: 'error',
        detail: 'no Codex auth signal detected in env or ~/.codex/auth.json',
        remediation:
          'Run `codex` and sign in, or set CODEX_API_KEY/OPENAI_API_KEY.',
      });
    }

    return diagnostics;
  }

  async run(input: ReviewProviderRunInput): Promise<ReviewProviderRunOutput> {
    const args = [
      '--output-last-message',
      `${TEMP_DIR_PLACEHOLDER}/last-message.txt`,
      'review',
      ...targetToArgs(input.request.target),
    ];
    if (input.request.model) {
      args.unshift('--model', input.request.model);
    }

    const output = await runCommand(
      {
        commandId: 'codex-review',
        cmd: this.codexBin,
        args,
        cwd: input.request.cwd,
        env: codexEnv(),
        timeoutMs: CODEX_REVIEW_TIMEOUT_MS,
        maxStdoutBytes: this.outputBytes,
        maxStderrBytes: this.outputBytes,
        maxFileBytes: this.outputBytes,
        maxTotalFileBytes: this.outputBytes,
        tempDirPrefix: 'review-agent-codex-',
        readFiles: [
          {
            key: LAST_MESSAGE_KEY,
            path: `${TEMP_DIR_PLACEHOLDER}/last-message.txt`,
            optional: true,
          },
        ],
      },
      input.abortSignal ? { signal: input.abortSignal } : undefined
    );

    const text = commandText(output);
    if (output.status !== 'completed' || output.exitCode !== 0) {
      throw new ReviewProviderCommandRunError(
        `codex delegate failed: ${text || output.status}`,
        output
      );
    }

    let raw: unknown = null;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = null;
    }

    return {
      raw,
      text,
      resolvedModel: input.request.model ?? 'codexDelegate:default',
      commandRun: output,
    };
  }
}

export function createCodexDelegateProvider(
  options: CodexProviderOptions = {}
): ReviewProvider {
  return new CodexDelegateProvider(options);
}
