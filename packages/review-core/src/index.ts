import { createHash, randomUUID } from 'node:crypto';
import {
  buildChangedLineIndex,
  collectDiffForTarget,
  type DiffChunk,
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
  type CorrelationIds,
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
import { minimatch } from 'minimatch';

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

function shouldIncludeChunk(
  chunk: DiffChunk,
  includePaths: string[] | undefined,
  excludePaths: string[] | undefined
): boolean {
  const includeAllowed =
    !includePaths || includePaths.length === 0
      ? true
      : includePaths.some((pattern) =>
          minimatch(chunk.file, pattern, { dot: true })
        );
  if (!includeAllowed) {
    return false;
  }
  if (!excludePaths || excludePaths.length === 0) {
    return true;
  }
  return !excludePaths.some((pattern) =>
    minimatch(chunk.file, pattern, { dot: true })
  );
}

function filterDiffContext(
  request: ReviewRequest,
  diff: DiffContext
): DiffContext {
  const maxFiles = request.maxFiles ?? Number.POSITIVE_INFINITY;
  const maxDiffBytes = request.maxDiffBytes ?? Number.POSITIVE_INFINITY;

  const filteredChunks: DiffChunk[] = [];
  let totalBytes = 0;
  for (const chunk of diff.chunks) {
    if (
      !shouldIncludeChunk(chunk, request.includePaths, request.excludePaths)
    ) {
      continue;
    }

    const chunkSize = Buffer.byteLength(chunk.patch, 'utf8');
    if (filteredChunks.length >= maxFiles) {
      break;
    }
    if (totalBytes + chunkSize > maxDiffBytes) {
      break;
    }
    totalBytes += chunkSize;
    filteredChunks.push(chunk);
  }

  return {
    ...diff,
    chunks: filteredChunks,
    patch: filteredChunks.map((chunk) => chunk.patch).join('\n'),
    changedLineIndex: buildChangedLineIndex(filteredChunks),
  };
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
      : filterDiffContext(
          request,
          await collectDiffForTarget(request.cwd, request.target)
        );
  const normalizedDiffChunks = diff.chunks.map((chunk) => ({
    file: chunk.file,
    patch: chunk.patch,
  }));

  const providerInput: ReviewProviderRunInput = {
    request,
    resolvedPrompt: resolved.prompt,
    rubric: REVIEW_RUBRIC_PROMPT,
    normalizedDiffChunks,
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
    const sandboxOutput = await runner(providerInput);
    providerOutput = sandboxOutput;
    sandboxAudit = sandboxOutput.sandboxAudit;
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
    providerOutput = await provider.run(providerInput);
  }

  const normalized = normalizeModelOutput(
    providerOutput.raw,
    providerOutput.text
  );
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
