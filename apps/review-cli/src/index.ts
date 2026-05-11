#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ConvexMetadataBridge } from '@review-agent/review-convex-bridge';
import { computeExitCode, runReview } from '@review-agent/review-core';
import {
  createReviewProviders,
  type DoctorCheck,
  filterDoctorChecks,
  listModelCatalog,
  normalizeCliProviderModel,
  runProviderDoctorChecks,
} from '@review-agent/review-provider-registry';
import {
  type LifecycleEvent,
  type OutputFormat,
  OutputFormatSchema,
  type ReviewRequest,
  ReviewRequestSchema,
  type ReviewTarget,
} from '@review-agent/review-types';
import { program } from 'commander';

type RunCliOptions = {
  uncommitted?: boolean;
  base?: string;
  commit?: string;
  title?: string;
  prompt?: string;
  provider: 'codex' | 'gateway' | 'openrouter';
  execution: 'local-trusted' | 'remote-sandbox';
  model?: string;
  format?: string[];
  output: string;
  severityThreshold?: 'p0' | 'p1' | 'p2' | 'p3';
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  detached?: boolean;
  includePath?: string[];
  excludePath?: string[];
  maxFiles?: string;
  maxDiffBytes?: string;
  cwd?: string;
  quiet?: boolean;
  convexMirror?: boolean;
};

function toOutputFormats(values: string[] | undefined): OutputFormat[] {
  const defaults: OutputFormat[] = ['sarif', 'json', 'markdown'];
  const candidate = values && values.length > 0 ? values : defaults;
  return candidate.map((value) => OutputFormatSchema.parse(value));
}

function parseTarget(options: RunCliOptions): ReviewTarget {
  const selectedTargets = [
    Boolean(options.uncommitted),
    Boolean(options.base),
    Boolean(options.commit),
    Boolean(options.prompt),
  ].filter(Boolean).length;
  if (selectedTargets !== 1) {
    throw new Error(
      'Specify exactly one review target: --uncommitted | --base | --commit | --prompt'
    );
  }

  if (options.uncommitted) {
    return { type: 'uncommittedChanges' };
  }
  if (options.base) {
    return { type: 'baseBranch', branch: options.base.trim() };
  }
  if (options.commit) {
    return {
      type: 'commit',
      sha: options.commit.trim(),
      title: options.title?.trim() || undefined,
    };
  }
  if (options.prompt) {
    return {
      type: 'custom',
      instructions: options.prompt.trim(),
    };
  }
  throw new Error(
    'Specify one review target: --uncommitted | --base | --commit | --prompt'
  );
}

function printDoctorChecks(checks: DoctorCheck[]): void {
  for (const check of checks) {
    const status = check.ok ? 'OK' : 'FAIL';
    console.error(`[${status}] ${check.name}: ${check.detail}`);
    if (!check.ok && check.remediation) {
      console.error(`  remediation: ${check.remediation}`);
    }
  }
}

function parsePositiveIntOption(
  input: string | undefined,
  name: string
): number | undefined {
  if (input == null || input.trim().length === 0) {
    return undefined;
  }

  const parsed = Number(input.trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function parseDoctorProviderFilter(
  value: string
): Parameters<typeof filterDoctorChecks>[1] {
  if (
    value === 'codex' ||
    value === 'gateway' ||
    value === 'openrouter' ||
    value === 'all'
  ) {
    return value;
  }
  throw new Error(
    `invalid provider filter "${value}"; expected codex|gateway|openrouter|all`
  );
}

function mapErrorToExitCode(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/auth|unauthoriz|api key|token/i.test(message)) {
    return 3;
  }
  if (/sandbox|budget|runtime|command/i.test(message)) {
    return 4;
  }
  if (
    /target|usage|invalid|schema|format|--provider|model id|model route/i.test(
      message
    )
  ) {
    return 2;
  }
  return 4;
}

function buildCompletionScript(shell: string): string {
  const command = 'review-agent';
  if (shell === 'bash') {
    return `_${command}_completions() { COMPREPLY=( $(compgen -W "run models doctor completion" -- "\${COMP_WORDS[1]}") ); }\ncomplete -F _${command}_completions ${command}\n`;
  }
  if (shell === 'zsh') {
    return `#compdef ${command}\n_arguments '1: :((run models doctor completion))'\n`;
  }
  if (shell === 'fish') {
    return `complete -c ${command} -f -a "run models doctor completion"\n`;
  }
  throw new Error(`unsupported shell: ${shell}`);
}

async function writeOutput(outputPath: string, payload: string): Promise<void> {
  if (outputPath === '-') {
    process.stdout.write(`${payload}\n`);
    return;
  }
  await writeFile(resolve(outputPath), payload, 'utf8');
}

async function runCommand(options: RunCliOptions): Promise<number> {
  const target = parseTarget(options);
  const providerConfig = normalizeCliProviderModel(
    options.provider,
    options.model
  );
  const maxFiles = parsePositiveIntOption(options.maxFiles, 'max-files');
  const maxDiffBytes = parsePositiveIntOption(
    options.maxDiffBytes,
    'max-diff-bytes'
  );
  const outputFormats = toOutputFormats(options.format);
  const request: ReviewRequest = ReviewRequestSchema.parse({
    cwd: resolve(options.cwd ?? process.cwd()),
    target,
    provider: providerConfig.provider,
    executionMode:
      options.execution === 'remote-sandbox' ? 'remoteSandbox' : 'localTrusted',
    model: providerConfig.model,
    reasoningEffort: options.reasoningEffort,
    includePaths: options.includePath,
    excludePaths: options.excludePath,
    maxFiles,
    maxDiffBytes,
    outputFormats,
    severityThreshold: options.severityThreshold,
    detached: Boolean(options.detached),
  });

  const providers = createReviewProviders();
  const bridge = options.convexMirror ? new ConvexMetadataBridge() : undefined;
  const onEvent = options.quiet
    ? undefined
    : (event: LifecycleEvent) => {
        if (event.type === 'progress') {
          console.error(`[progress] ${event.message}`);
        }
        if (event.type === 'enteredReviewMode') {
          console.error(`[review] started: ${event.review}`);
        }
        if (event.type === 'exitedReviewMode') {
          console.error('[review] finished');
        }
      };

  const run = await runReview(
    request,
    {
      providers,
      ...(onEvent ? { onEvent } : {}),
    },
    bridge
  );

  let payload = '';
  if (outputFormats.length === 1) {
    const onlyFormat = outputFormats[0];
    if (!onlyFormat) {
      throw new Error('at least one output format is required');
    }
    payload = run.artifacts[onlyFormat] ?? '';
  } else {
    payload = JSON.stringify(run.artifacts, null, 2);
  }
  await writeOutput(options.output, payload);
  return computeExitCode(run.result, request.severityThreshold);
}

async function main(): Promise<void> {
  program
    .name('review-agent')
    .description('Codex-grade review agent CLI')
    .version('0.1.0');

  program
    .command('run')
    .description('Run a review')
    .option('--uncommitted', 'review staged/unstaged/untracked files')
    .option('--base <branch>', 'review against base branch')
    .option('--commit <sha>', 'review a commit')
    .option('--title <title>', 'optional commit title (requires --commit)')
    .option('--prompt <instructions>', 'custom review instructions')
    .option('--provider <provider>', 'codex|gateway|openrouter', 'codex')
    .option(
      '--execution <mode>',
      'local-trusted|remote-sandbox',
      'local-trusted'
    )
    .option('--model <modelId>', 'provider-specific model id')
    .option('--format <format...>', 'sarif|json|markdown')
    .option('--output <path>', 'output file path or - for stdout', '-')
    .option('--severity-threshold <threshold>', 'p0|p1|p2|p3')
    .option('--reasoning-effort <effort>', 'minimal|low|medium|high|xhigh')
    .option('--detached', 'request detached execution')
    .option('--include-path <glob...>', 'only include matching paths')
    .option('--exclude-path <glob...>', 'exclude matching paths')
    .option('--max-files <n>', 'max files in diff context')
    .option('--max-diff-bytes <n>', 'max diff bytes in context')
    .option('--cwd <path>', 'working directory')
    .option('--quiet', 'suppress progress events')
    .option('--convex-mirror', 'enable optional convex metadata mirror writes')
    .action(async (options: RunCliOptions) => {
      try {
        const code = await runCommand(options);
        process.exitCode = code;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exitCode = mapErrorToExitCode(error);
      }
    });

  program
    .command('models')
    .description('List provider-registry model presets')
    .action(() => {
      const models = listModelCatalog();
      process.stdout.write(`${JSON.stringify(models, null, 2)}\n`);
    });

  program
    .command('doctor')
    .description('Run provider/config checks')
    .option('--provider <provider>', 'codex|gateway|openrouter|all', 'all')
    .option('--json', 'emit machine-readable diagnostics')
    .action(async (options: { provider: string; json?: boolean }) => {
      try {
        const provider = parseDoctorProviderFilter(options.provider);
        const checks = filterDoctorChecks(
          await runProviderDoctorChecks(createReviewProviders()),
          provider
        );
        if (checks.length === 0) {
          throw new Error(
            `no doctor checks matched provider "${options.provider}"`
          );
        }

        if (options.json) {
          process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
        } else {
          printDoctorChecks(checks);
        }

        const hasFailures = checks.some((check) => !check.ok);
        if (!hasFailures) {
          process.exitCode = 0;
          return;
        }
        const hasAuthOrProviderFailure = checks.some(
          (check) =>
            !check.ok &&
            (check.name.includes('auth_missing') ||
              check.name.includes('binary_missing') ||
              check.name.includes('provider_unavailable'))
        );
        process.exitCode = hasAuthOrProviderFailure ? 3 : 2;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exitCode = mapErrorToExitCode(error);
      }
    });

  program
    .command('completion')
    .description('Print shell completion script')
    .argument('<shell>', 'bash|zsh|fish')
    .action((shell: string) => {
      const script = buildCompletionScript(shell);
      process.stdout.write(script);
    });

  await program.parseAsync(process.argv);
}

await main();
