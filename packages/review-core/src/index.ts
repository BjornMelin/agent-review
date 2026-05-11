import { createHash, randomUUID } from 'node:crypto';
import {
  collectDiffForReviewRequest,
  type DiffContext,
  normalizeFilePath,
} from '@review-agent/review-git';
import {
  REVIEW_PROMPT_PACK_ID,
  REVIEW_RUBRIC_PROMPT,
  resolveReviewRequest,
} from '@review-agent/review-prompts';
import {
  renderJson,
  renderMarkdown,
  renderSarifJson,
  sortFindingsDeterministically,
} from '@review-agent/review-reporters';
import {
  type CommandRunOutput,
  type CorrelationIds,
  getReviewProviderCommandRun,
  hasFindingsAtOrAboveThreshold,
  type LifecycleEvent,
  type OutputFormat,
  type ProviderDiagnostic,
  parseRawModelOutput,
  parseReviewRequest,
  type RawModelOutput,
  type ReviewFinding,
  type ReviewProvider,
  type ReviewProviderRunInput,
  type ReviewProviderRunOutput,
  type ReviewRequest,
  type ReviewResult,
  type SandboxAudit,
  severityToPriority,
} from '@review-agent/review-types';

export class InvalidFindingLocationError extends Error {
  constructor(public readonly invalidFindings: ReviewFinding[]) {
    super('One or more findings referenced lines outside the reviewed diff.');
  }
}

export class UnsupportedRemoteSandboxTargetError extends Error {
  constructor(targetType: ReviewRequest['target']['type']) {
    super(
      `executionMode "remoteSandbox" currently supports only custom targets until sandbox source binding is implemented; received target "${targetType}"`
    );
  }
}

/**
 * Represents a review run cancellation caused by an abort signal.
 */
export class ReviewRunCancelledError extends Error {
  constructor(message = 'review run cancelled') {
    super(message);
    this.name = 'ReviewRunCancelledError';
  }
}

export type ReviewArtifacts = Partial<Record<OutputFormat, string>>;

export type ReviewRunResult = {
  reviewId: string;
  request: ReviewRequest;
  result: ReviewResult;
  artifacts: ReviewArtifacts;
  diff: DiffContext;
  prompt: string;
  rubric: string;
  sandboxAudit?: SandboxAudit;
  commandRuns?: CommandRunOutput[];
};

export type SandboxReviewRunner = (
  input: ReviewProviderRunInput
) => Promise<ReviewProviderRunOutput & { sandboxAudit: SandboxAudit }>;

/**
 * Configures provider selection, lifecycle event handling, and correlation metadata for one review run.
 */
export type RunReviewOptions = {
  providers: Record<ReviewRequest['provider'], ReviewProvider>;
  onEvent?: (event: LifecycleEvent) => void | Promise<void>;
  now?: () => Date;
  correlation?: Omit<CorrelationIds, 'reviewId'>;
  sandboxRunner?: SandboxReviewRunner;
  signal?: AbortSignal;
};

export type MirrorWriteBridge = {
  mirrorWrite(reviewId: string, result: ReviewResult): Promise<boolean>;
};

const DEFAULT_MODEL = 'unknown';

type EmitContext = {
  onEvent: RunReviewOptions['onEvent'];
  nowMs: () => number;
  correlation: CorrelationIds;
};

type LifecycleEventPayload = {
  [TType in LifecycleEvent['type']]: Omit<
    Extract<LifecycleEvent, { type: TType }>,
    'meta'
  >;
}[LifecycleEvent['type']];

async function emit(
  context: EmitContext,
  event: LifecycleEventPayload,
  correlationOverride?: Partial<CorrelationIds>
): Promise<void> {
  const correlation: CorrelationIds = {
    ...context.correlation,
    ...correlationOverride,
  };
  const enrichedEvent: LifecycleEvent = {
    ...event,
    meta: {
      eventId: randomUUID(),
      timestampMs: context.nowMs(),
      correlation,
    },
  };
  await context.onEvent?.(enrichedEvent);
}

async function emitCommandRunProgress(
  emitContext: EmitContext,
  commandRuns: CommandRunOutput[]
): Promise<void> {
  for (const commandRun of commandRuns) {
    await emit(
      emitContext,
      {
        type: 'progress',
        message: `Command ${commandRun.commandId} finished with ${commandRun.status}`,
      },
      { commandId: commandRun.commandId }
    );
    for (const event of commandRun.events) {
      await emit(
        emitContext,
        {
          type: 'progress',
          message: event.message
            ? `Command ${commandRun.commandId} event ${event.type}: ${event.message}`
            : `Command ${commandRun.commandId} event ${event.type}`,
        },
        { commandId: event.commandId }
      );
    }
  }
}

function maybeExtractJsonObject(text: string): unknown | null {
  const direct = text.trim();
  if (!direct) {
    return null;
  }

  try {
    return JSON.parse(direct);
  } catch {
    // Continue with fallback extraction.
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) {
    return null;
  }

  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function normalizeModelOutput(
  raw: unknown,
  text: string
): Omit<ReviewResult, 'metadata'> {
  try {
    const parsed = parseRawModelOutput(raw);
    return normalizeRawModelOutput(parsed);
  } catch {
    const extracted = maybeExtractJsonObject(text);
    if (extracted) {
      try {
        const parsed = parseRawModelOutput(extracted);
        return normalizeRawModelOutput(parsed);
      } catch {
        // Fall through to plain-text fallback.
      }
    }
  }

  return {
    findings: [],
    overallCorrectness: 'unknown',
    overallExplanation:
      text.trim() || 'Reviewer did not return structured JSON output.',
    overallConfidenceScore: 0,
  };
}

function normalizeRawModelOutput(
  raw: RawModelOutput
): Omit<ReviewResult, 'metadata'> {
  return {
    findings: raw.findings.map((finding) => ({
      title: finding.title,
      body: finding.body,
      priority: finding.priority,
      confidenceScore: finding.confidence_score,
      codeLocation: {
        absoluteFilePath: finding.code_location.absolute_file_path,
        lineRange: {
          start: finding.code_location.line_range.start,
          end: finding.code_location.line_range.end,
        },
      },
      fingerprint: '',
    })),
    overallCorrectness: raw.overall_correctness,
    overallExplanation: raw.overall_explanation,
    overallConfidenceScore: raw.overall_confidence_score,
  };
}

function fingerprintFinding(
  finding: Omit<ReviewFinding, 'fingerprint'>
): string {
  const payload = [
    finding.title,
    finding.body,
    finding.priority ?? 'na',
    finding.codeLocation.absoluteFilePath,
    finding.codeLocation.lineRange.start,
    finding.codeLocation.lineRange.end,
  ].join('|');
  return createHash('sha256').update(payload).digest('hex');
}

function inDiffRange(
  lineSet: Set<number>,
  start: number,
  end: number
): boolean {
  for (let line = start; line <= end; line += 1) {
    if (lineSet.has(line)) {
      return true;
    }
  }
  return false;
}

function validateFindingsAgainstDiff(
  findings: ReviewFinding[],
  diff: DiffContext,
  cwd: string
): ReviewFinding[] {
  if (diff.changedLineIndex.size === 0) {
    return findings;
  }

  const invalidFindings: ReviewFinding[] = [];

  for (const finding of findings) {
    const absoluteFilePath = normalizeFilePath(
      cwd,
      finding.codeLocation.absoluteFilePath
    );
    const lineSet = diff.changedLineIndex.get(absoluteFilePath);
    if (!lineSet) {
      invalidFindings.push(finding);
      continue;
    }

    const start = finding.codeLocation.lineRange.start;
    const end = finding.codeLocation.lineRange.end;
    if (!inDiffRange(lineSet, start, end)) {
      invalidFindings.push(finding);
    }
  }

  if (invalidFindings.length > 0) {
    throw new InvalidFindingLocationError(invalidFindings);
  }

  return findings;
}

function createRemoteSandboxDiffContext(request: ReviewRequest): DiffContext {
  if (request.target.type !== 'custom') {
    throw new UnsupportedRemoteSandboxTargetError(request.target.type);
  }
  return {
    patch: '',
    chunks: [],
    changedLineIndex: new Map(),
    gitContext: { mode: 'custom' },
  };
}

function renderArtifacts(
  result: ReviewResult,
  formats: OutputFormat[]
): ReviewArtifacts {
  const artifacts: ReviewArtifacts = {};
  for (const format of formats) {
    switch (format) {
      case 'json':
        artifacts.json = renderJson(result);
        break;
      case 'markdown':
        artifacts.markdown = renderMarkdown(result);
        break;
      case 'sarif':
        artifacts.sarif = renderSarifJson(result);
        break;
    }
  }
  return artifacts;
}

function collectProviderDiagnostics(
  provider: ReviewProvider,
  request: ReviewRequest
): ProviderDiagnostic[] {
  const diagnostics: ProviderDiagnostic[] = [];
  const capabilities = provider.capabilities();
  const providerDiagnostics =
    provider.validateRequest?.({ request, capabilities }) ?? [];
  diagnostics.push(...providerDiagnostics);

  if (request.reasoningEffort && !capabilities.reasoningControl) {
    diagnostics.push({
      code: 'unsupported_reasoning_effort',
      ok: false,
      severity: 'error',
      detail: `provider "${provider.id}" does not support reasoning effort controls`,
      remediation:
        'Remove --reasoning-effort or choose a provider/model that supports it.',
    });
  }

  return diagnostics;
}

function throwOnBlockingDiagnostics(diagnostics: ProviderDiagnostic[]): void {
  const blocking = diagnostics.filter(
    (diagnostic) => !diagnostic.ok && diagnostic.severity === 'error'
  );
  if (blocking.length === 0) {
    return;
  }
  const detail = blocking
    .map((diagnostic) => `${diagnostic.code}: ${diagnostic.detail}`)
    .join('; ');
  throw new Error(`provider diagnostics failed: ${detail}`);
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw cancellationErrorFromSignal(signal);
}

function cancellationErrorFromSignal(
  signal: AbortSignal
): ReviewRunCancelledError {
  return new ReviewRunCancelledError(
    signal.reason instanceof Error
      ? signal.reason.message
      : 'review run cancelled'
  );
}

function normalizeCancellationError(
  error: unknown,
  signal: AbortSignal | undefined
): unknown {
  return signal?.aborted ? cancellationErrorFromSignal(signal) : error;
}

export function computeExitCode(
  result: ReviewResult,
  threshold?: ReviewRequest['severityThreshold']
): number {
  if (!threshold) {
    return result.findings.length > 0 ? 1 : 0;
  }
  return hasFindingsAtOrAboveThreshold(result.findings, threshold) ? 1 : 0;
}

export async function runReview(
  input: unknown,
  options: RunReviewOptions,
  bridge?: MirrorWriteBridge
): Promise<ReviewRunResult> {
  const request = parseReviewRequest(input);
  throwIfCancelled(options.signal);
  const reviewId = randomUUID();
  const now = options.now ?? (() => new Date());
  const emitContext: EmitContext = {
    onEvent: options.onEvent,
    nowMs: () => now().getTime(),
    correlation: {
      reviewId,
      ...(options.correlation ?? {}),
    },
  };

  const provider = options.providers[request.provider];
  const sandboxRunner = options.sandboxRunner;
  if (request.executionMode === 'remoteSandbox') {
    if (request.target.type !== 'custom') {
      throw new UnsupportedRemoteSandboxTargetError(request.target.type);
    }
    if (!sandboxRunner) {
      throw new Error(
        'executionMode "remoteSandbox" requires a configured sandbox runner'
      );
    }
  } else {
    if (!provider) {
      throw new Error(`provider "${request.provider}" is not configured`);
    }
    throwOnBlockingDiagnostics(collectProviderDiagnostics(provider, request));
  }

  const resolved = await resolveReviewRequest(
    {
      target: request.target,
    },
    request.cwd
  );
  throwIfCancelled(options.signal);
  await emit(emitContext, {
    type: 'enteredReviewMode',
    review: resolved.userFacingHint,
  });
  await emit(emitContext, {
    type: 'progress',
    message:
      request.executionMode === 'remoteSandbox'
        ? 'Preparing remote sandbox context'
        : 'Collecting diff context',
  });

  const diff =
    request.executionMode === 'remoteSandbox'
      ? createRemoteSandboxDiffContext(request)
      : await collectDiffForReviewRequest(request);
  throwIfCancelled(options.signal);
  const normalizedDiffChunks = diff.chunks.map((chunk) => ({
    file: chunk.file,
    patch: chunk.patch,
  }));

  const providerInput: ReviewProviderRunInput = {
    request,
    resolvedPrompt: resolved.prompt,
    rubric: REVIEW_RUBRIC_PROMPT,
    normalizedDiffChunks,
    ...(options.signal ? { abortSignal: options.signal } : {}),
  };
  let providerOutput: ReviewProviderRunOutput;
  let sandboxAudit: SandboxAudit | undefined;
  if (request.executionMode === 'remoteSandbox') {
    const runner = sandboxRunner;
    if (!runner) {
      throw new Error(
        'executionMode "remoteSandbox" requires a configured sandbox runner'
      );
    }
    await emit(emitContext, {
      type: 'progress',
      message: `Running remote sandbox review on ${normalizedDiffChunks.length} diff chunk(s)`,
    });
    try {
      const sandboxOutput = await runner(providerInput);
      throwIfCancelled(options.signal);
      providerOutput = sandboxOutput;
      sandboxAudit = sandboxOutput.sandboxAudit;
    } catch (error) {
      throw normalizeCancellationError(error, options.signal);
    }
    await emit(
      emitContext,
      {
        type: 'progress',
        message: `Remote sandbox ${sandboxAudit.sandboxId} completed`,
      },
      { sandboxId: sandboxAudit.sandboxId }
    );
  } else {
    await emit(emitContext, {
      type: 'progress',
      message: `Running provider ${provider.id} on ${normalizedDiffChunks.length} diff chunk(s)`,
    });
    try {
      providerOutput = await provider.run(providerInput);
      throwIfCancelled(options.signal);
    } catch (error) {
      const commandRun = getReviewProviderCommandRun(error);
      if (commandRun) {
        await emitCommandRunProgress(emitContext, [commandRun]);
      }
      throw normalizeCancellationError(error, options.signal);
    }
  }

  const normalized = normalizeModelOutput(
    providerOutput.raw,
    providerOutput.text
  );
  throwIfCancelled(options.signal);
  const commandRuns = providerOutput.commandRun
    ? [providerOutput.commandRun]
    : [];
  await emitCommandRunProgress(emitContext, commandRuns);
  const findingsWithFingerprint: ReviewFinding[] = normalized.findings.map(
    (finding) => {
      const normalizedPath = normalizeFilePath(
        request.cwd,
        finding.codeLocation.absoluteFilePath
      );
      const cleaned = {
        ...finding,
        codeLocation: {
          ...finding.codeLocation,
          absoluteFilePath: normalizedPath,
        },
      };
      return {
        ...cleaned,
        fingerprint: fingerprintFinding(cleaned),
      };
    }
  );

  validateFindingsAgainstDiff(findingsWithFingerprint, diff, request.cwd);

  const result: ReviewResult = {
    findings: sortFindingsDeterministically(findingsWithFingerprint),
    overallCorrectness: normalized.overallCorrectness,
    overallExplanation: normalized.overallExplanation,
    overallConfidenceScore: normalized.overallConfidenceScore,
    metadata: {
      provider: request.provider,
      modelResolved:
        providerOutput.resolvedModel ??
        request.model ??
        `${request.provider}:${DEFAULT_MODEL}`,
      executionMode: request.executionMode,
      promptPack: REVIEW_PROMPT_PACK_ID,
      gitContext: diff.gitContext,
      ...(sandboxAudit ? { sandboxId: sandboxAudit.sandboxId } : {}),
    },
  };

  const artifacts = renderArtifacts(result, request.outputFormats);
  await emit(emitContext, {
    type: 'exitedReviewMode',
    review: result.overallExplanation,
  });
  for (const format of Object.keys(artifacts) as OutputFormat[]) {
    await emit(emitContext, { type: 'artifactReady', format });
  }

  if (bridge) {
    try {
      await bridge.mirrorWrite(reviewId, result);
    } catch (error) {
      await emit(emitContext, {
        type: 'progress',
        message: `non-blocking mirror write failed: ${String(error)}`,
      });
    }
  }

  // Keep a low-noise progress marker for logs/telemetry consumers.
  await emit(emitContext, {
    type: 'progress',
    message: `Review ${reviewId} completed at ${now().toISOString()}`,
  });

  return {
    reviewId,
    request,
    result,
    artifacts,
    diff,
    prompt: resolved.prompt,
    rubric: REVIEW_RUBRIC_PROMPT,
    ...(commandRuns.length > 0 ? { commandRuns } : {}),
    ...(sandboxAudit ? { sandboxAudit } : {}),
  };
}

export function validateSeverityThreshold(
  value: string
): asserts value is NonNullable<ReviewRequest['severityThreshold']> {
  const valid = new Set(['p0', 'p1', 'p2', 'p3']);
  if (!valid.has(value)) {
    throw new Error(`invalid severity threshold: ${value}`);
  }
}

export function findingsAtOrAboveThreshold(
  result: ReviewResult,
  threshold: ReviewRequest['severityThreshold']
): ReviewFinding[] {
  if (!threshold) {
    return result.findings;
  }
  const maxPriority = severityToPriority(threshold);
  return result.findings.filter(
    (finding) => (finding.priority ?? 3) <= maxPriority
  );
}
