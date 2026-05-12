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
  type ModelEntry,
  normalizeCliProviderModel,
  runProviderDoctorChecks,
} from '@review-agent/review-provider-registry';
import {
  type LifecycleEvent,
  type OutputFormat,
  OutputFormatSchema,
  type ReviewRepositorySelection,
  type ReviewRequest,
  ReviewRequestSchema,
  type ReviewRunStatus,
  type ReviewStartRequest,
  ReviewStartRequestSchema,
  type ReviewTarget,
} from '@review-agent/review-types';
import { program } from 'commander';
import {
  cancelReview,
  fetchReviewArtifact,
  getReviewStatus,
  listReviewRuns,
  publishReview,
  resolveReviewServiceConfig,
  ServiceClientError,
  startReview,
  watchReviewEvents,
} from './service-client.js';

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
  serviceUrl?: string;
  serviceToken?: string;
  repo?: string;
  repositoryId?: string;
  installationId?: string;
  pullRequest?: string;
  ref?: string;
  commitSha?: string;
};

type ServiceCliOptions = {
  serviceUrl?: string;
  serviceToken?: string;
  output?: string;
};

type RepositoryCliOptions = {
  repo?: string;
  repositoryId?: string;
  installationId?: string;
  pullRequest?: string;
  ref?: string;
  commitSha?: string;
};

type WatchCliOptions = ServiceCliOptions & {
  afterEventId?: string;
  limit?: string;
};

type ListCliOptions = ServiceCliOptions & {
  limit?: string;
  status?: string;
  cursor?: string;
  repo?: string;
};

type ArtifactCliOptions = ServiceCliOptions;

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

function printModelCatalog(models: ModelEntry[]): void {
  for (const model of models) {
    const fallback =
      model.policy.fallbackOrder.length === 0
        ? 'none'
        : model.policy.fallbackOrder.join(', ');
    const defaultMarker = model.default ? ' (default)' : '';
    process.stdout.write(
      [
        `${model.id}${defaultMarker}`,
        `  provider: ${model.provider}`,
        `  retention: ${model.policy.retention}; zdr: ${
          model.policy.zdrRequired ? 'required' : 'not required'
        }; prompt training: ${
          model.policy.disallowPromptTraining ? 'disabled' : 'allowed'
        }`,
        `  budget: input ${model.policy.maxInputChars} chars; output ${model.policy.maxOutputTokens} tokens; timeout ${model.policy.timeoutMs}ms; attempts ${model.policy.maxAttempts}`,
        `  fallback: ${fallback}`,
        '',
      ].join('\n')
    );
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

function parsePositiveInt(
  input: string | undefined,
  name: string
): number | undefined {
  return parsePositiveIntOption(input, name);
}

function parseRepositoryFullName(
  repo: string | undefined
): Pick<ReviewRepositorySelection, 'owner' | 'name'> | undefined {
  const candidate = repo?.trim() || process.env.GITHUB_REPOSITORY?.trim();
  if (!candidate) {
    return undefined;
  }
  const [owner, name, extra] = candidate.split('/');
  if (!owner || !name || extra) {
    throw new Error(
      '--repo must use owner/name format when selecting a hosted repository'
    );
  }
  return { owner, name };
}

function parseRepositorySelection(
  options: RepositoryCliOptions
): ReviewRepositorySelection | undefined {
  const repo = parseRepositoryFullName(options.repo);
  const repositoryId = parsePositiveInt(
    options.repositoryId ?? process.env.GITHUB_REPOSITORY_ID,
    'repository-id'
  );
  const installationId = parsePositiveInt(
    options.installationId ?? process.env.REVIEW_AGENT_GITHUB_INSTALLATION_ID,
    'installation-id'
  );
  const pullRequestNumber = parsePositiveInt(
    options.pullRequest,
    'pull-request'
  );

  if (
    !repo &&
    repositoryId === undefined &&
    installationId === undefined &&
    pullRequestNumber === undefined &&
    options.ref === undefined &&
    options.commitSha === undefined
  ) {
    return undefined;
  }

  if (!repo) {
    throw new Error(
      '--repo owner/name is required when repository metadata flags are set'
    );
  }

  return {
    provider: 'github',
    owner: repo.owner,
    name: repo.name,
    ...(repositoryId === undefined ? {} : { repositoryId }),
    ...(installationId === undefined ? {} : { installationId }),
    ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }),
    ...(options.ref === undefined ? {} : { ref: options.ref.trim() }),
    ...(options.commitSha === undefined
      ? {}
      : { commitSha: options.commitSha.trim() }),
  };
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

function parseReviewRunStatusOption(
  value: string | undefined
): ReviewRunStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  const status = value.trim();
  if (
    status === 'queued' ||
    status === 'running' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled'
  ) {
    return status;
  }
  throw new Error(
    `invalid --status "${status}"; expected queued|running|completed|failed|cancelled`
  );
}

function mapErrorToExitCode(error: unknown): number {
  if (error instanceof ServiceClientError) {
    return error.exitCode;
  }
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
  const commands =
    'run submit list status watch artifact cancel publish models doctor completion';
  if (shell === 'bash') {
    return `_${command}_completions() { COMPREPLY=( $(compgen -W "${commands}" -- "\${COMP_WORDS[1]}") ); }\ncomplete -F _${command}_completions ${command}\n`;
  }
  if (shell === 'zsh') {
    return `#compdef ${command}\n_arguments '1: :((${commands}))'\n`;
  }
  if (shell === 'fish') {
    return `complete -c ${command} -f -a "${commands}"\n`;
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

async function writeRawOutput(
  outputPath: string,
  payload: string | Uint8Array
): Promise<void> {
  if (outputPath === '-') {
    process.stdout.write(payload);
    return;
  }
  await writeFile(resolve(outputPath), payload, 'utf8');
}

function buildReviewRequest(options: RunCliOptions): ReviewRequest {
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
  return ReviewRequestSchema.parse({
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
}

async function submitCommand(options: RunCliOptions): Promise<number> {
  const request = buildReviewRequest({ ...options, detached: true });
  const serviceRequest: ReviewStartRequest = ReviewStartRequestSchema.parse({
    request: { ...request, detached: true },
    delivery: 'detached',
    repository: parseRepositorySelection(options),
  });
  const response = await startReview(
    resolveReviewServiceConfig(options),
    serviceRequest
  );
  await writeOutput(options.output, JSON.stringify(response, null, 2));
  return 0;
}

async function runCommand(options: RunCliOptions): Promise<number> {
  if (options.detached) {
    return submitCommand(options);
  }

  const request = buildReviewRequest(options);
  const outputFormats = request.outputFormats;

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

async function statusCommand(
  reviewId: string,
  options: ServiceCliOptions
): Promise<number> {
  const response = await getReviewStatus(
    resolveReviewServiceConfig(options),
    reviewId
  );
  await writeOutput(options.output ?? '-', JSON.stringify(response, null, 2));
  if (response.status === 'failed' || response.status === 'cancelled') {
    return 4;
  }
  return 0;
}

async function listCommand(options: ListCliOptions): Promise<number> {
  const repository = parseRepositoryFullName(options.repo);
  const limit = parsePositiveInt(options.limit, 'limit');
  const status = parseReviewRunStatusOption(options.status);
  const response = await listReviewRuns(resolveReviewServiceConfig(options), {
    ...(limit === undefined ? {} : { limit }),
    ...(status === undefined ? {} : { status }),
    ...(options.cursor ? { cursor: options.cursor.trim() } : {}),
    ...(repository ? { owner: repository.owner, name: repository.name } : {}),
  });
  await writeOutput(options.output ?? '-', JSON.stringify(response, null, 2));
  return 0;
}

async function watchCommand(
  reviewId: string,
  options: WatchCliOptions
): Promise<number> {
  const limit = parsePositiveInt(options.limit, 'limit');
  return watchReviewEvents(resolveReviewServiceConfig(options), reviewId, {
    ...(options.afterEventId ? { afterEventId: options.afterEventId } : {}),
    ...(limit === undefined ? {} : { limit }),
    onEvent: (event) => {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    },
  });
}

async function artifactCommand(
  reviewId: string,
  format: string,
  options: ArtifactCliOptions
): Promise<number> {
  const parsedFormat = OutputFormatSchema.parse(format.trim().toLowerCase());
  const artifact = await fetchReviewArtifact(
    resolveReviewServiceConfig(options),
    reviewId,
    parsedFormat
  );
  await writeRawOutput(options.output ?? '-', artifact);
  return 0;
}

async function cancelCommand(
  reviewId: string,
  options: ServiceCliOptions
): Promise<number> {
  const response = await cancelReview(
    resolveReviewServiceConfig(options),
    reviewId
  );
  await writeOutput(options.output ?? '-', JSON.stringify(response, null, 2));
  return 0;
}

async function publishCommand(
  reviewId: string,
  options: ServiceCliOptions
): Promise<number> {
  const response = await publishReview(
    resolveReviewServiceConfig(options),
    reviewId
  );
  await writeOutput(options.output ?? '-', JSON.stringify(response, null, 2));
  if (response.status === 'partial' || response.status === 'failed') {
    return 4;
  }
  return 0;
}

function addReviewRequestOptions(command: typeof program): typeof program {
  return command
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
    .option('--include-path <glob...>', 'only include matching paths')
    .option('--exclude-path <glob...>', 'exclude matching paths')
    .option('--max-files <n>', 'max files in diff context')
    .option('--max-diff-bytes <n>', 'max diff bytes in context')
    .option('--cwd <path>', 'working directory');
}

function addServiceOptions(command: typeof program): typeof program {
  return command
    .option('--service-url <url>', 'review service base URL')
    .option('--service-token <token>', 'review service bearer token');
}

function addRepositoryOptions(command: typeof program): typeof program {
  return command
    .option('--repo <owner/name>', 'GitHub repository for hosted auth')
    .option('--repository-id <id>', 'GitHub repository numeric id')
    .option('--installation-id <id>', 'GitHub App installation numeric id')
    .option('--pull-request <number>', 'GitHub pull request number')
    .option('--ref <ref>', 'GitHub ref for repository-scoped runs')
    .option(
      '--commit-sha <sha>',
      'GitHub commit sha for repository-scoped runs'
    );
}

async function runAction(
  action: () => Promise<number> | number,
  options?: ServiceCliOptions
): Promise<void> {
  try {
    process.exitCode = await action();
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const tokens = [
      options?.serviceToken,
      process.env.REVIEW_AGENT_SERVICE_TOKEN,
      process.env.REVIEW_SERVICE_TOKEN,
    ].flatMap((token) => {
      const trimmed = token?.trim();
      return trimmed ? [trimmed] : [];
    });
    const message = tokens.reduce(
      (current, token) => current.replaceAll(token, '[redacted]'),
      rawMessage
    );
    console.error(message);
    process.exitCode = mapErrorToExitCode(error);
  }
}

async function main(): Promise<void> {
  program
    .name('review-agent')
    .description('Codex-grade review agent CLI')
    .version('0.1.0');

  addRepositoryOptions(
    addServiceOptions(addReviewRequestOptions(program.command('run')))
  )
    .description('Run a review')
    .option('--detached', 'submit detached execution to the review service')
    .option('--quiet', 'suppress progress events')
    .option('--convex-mirror', 'enable optional convex metadata mirror writes')
    .action(async (options: RunCliOptions) => {
      await runAction(() => runCommand(options), options);
    });

  addRepositoryOptions(
    addServiceOptions(addReviewRequestOptions(program.command('submit')))
  )
    .description('Submit a detached review to the hosted service')
    .action(async (options: RunCliOptions) => {
      await runAction(() => submitCommand(options), options);
    });

  addServiceOptions(program.command('status'))
    .description('Fetch hosted review status')
    .argument('<reviewId>', 'review id')
    .option('--output <path>', 'output file path or - for stdout', '-')
    .action(async (reviewId: string, options: ServiceCliOptions) => {
      await runAction(() => statusCommand(reviewId, options), options);
    });

  addServiceOptions(program.command('list'))
    .description('List hosted review runs')
    .option('--limit <n>', 'max runs to return')
    .option('--status <status>', 'queued|running|completed|failed|cancelled')
    .option('--cursor <cursor>', 'opaque cursor from previous list page')
    .option('--repo <owner/name>', 'GitHub repository filter')
    .option('--output <path>', 'output file path or - for stdout', '-')
    .action(async (options: ListCliOptions) => {
      await runAction(() => listCommand(options), options);
    });

  addServiceOptions(program.command('watch'))
    .description('Watch hosted review lifecycle events')
    .argument('<reviewId>', 'review id')
    .option('--after-event-id <eventId>', 'resume after event id')
    .option('--limit <n>', 'max replay events before live streaming')
    .action(async (reviewId: string, options: WatchCliOptions) => {
      await runAction(() => watchCommand(reviewId, options), options);
    });

  addServiceOptions(program.command('artifact'))
    .description('Fetch a hosted review artifact')
    .argument('<reviewId>', 'review id')
    .argument('<format>', 'sarif|json|markdown')
    .option('--output <path>', 'output file path or - for stdout', '-')
    .action(
      async (reviewId: string, format: string, options: ArtifactCliOptions) => {
        await runAction(
          () => artifactCommand(reviewId, format, options),
          options
        );
      }
    );

  addServiceOptions(program.command('cancel'))
    .description('Cancel a hosted detached review')
    .argument('<reviewId>', 'review id')
    .option('--output <path>', 'output file path or - for stdout', '-')
    .action(async (reviewId: string, options: ServiceCliOptions) => {
      await runAction(() => cancelCommand(reviewId, options), options);
    });

  addServiceOptions(program.command('publish'))
    .description('Publish a completed hosted review to GitHub')
    .argument('<reviewId>', 'review id')
    .option('--output <path>', 'output file path or - for stdout', '-')
    .action(async (reviewId: string, options: ServiceCliOptions) => {
      await runAction(() => publishCommand(reviewId, options), options);
    });

  program
    .command('models')
    .description('List provider-registry model presets')
    .option('--json', 'emit machine-readable model catalog')
    .action((options: { json?: boolean }) => {
      const models = listModelCatalog();
      if (options.json) {
        process.stdout.write(`${JSON.stringify(models, null, 2)}\n`);
        return;
      }
      printModelCatalog(models);
    });

  program
    .command('doctor')
    .description('Run provider/config checks')
    .option('--provider <provider>', 'codex|gateway|openrouter|all', 'all')
    .option('--json', 'emit machine-readable diagnostics')
    .action(async (options: { provider: string; json?: boolean }) => {
      await runAction(async () => {
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
          return 0;
        }
        const hasAuthOrProviderFailure = checks.some(
          (check) =>
            !check.ok &&
            (check.name.includes('auth_missing') ||
              check.name.includes('binary_missing') ||
              check.name.includes('provider_unavailable'))
        );
        return hasAuthOrProviderFailure ? 3 : 2;
      });
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
