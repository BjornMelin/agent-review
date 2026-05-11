import { Buffer } from 'node:buffer';
import { z } from 'zod';

/**
 * Centralizes hosted and local review safety limits that bound request, diff,
 * prompt, artifact, and user-visible string surfaces.
 */
export type ReviewSecurityLimits = {
  maxCwdBytes: number;
  maxCustomInstructionsBytes: number;
  maxGitRefBytes: number;
  maxCommitTitleBytes: number;
  maxModelBytes: number;
  maxPathFilters: number;
  maxPathFilterBytes: number;
  maxOutputFormats: number;
  defaultMaxFiles: number;
  maxMaxFiles: number;
  defaultMaxDiffBytes: number;
  maxMaxDiffBytes: number;
  maxPromptBytes: number;
  maxArtifactBytes: number;
};

/**
 * Default review safety limits used when callers do not supply stricter caps.
 */
export const DEFAULT_REVIEW_SECURITY_LIMITS: ReviewSecurityLimits = {
  maxCwdBytes: 4096,
  maxCustomInstructionsBytes: 16 * 1024,
  maxGitRefBytes: 256,
  maxCommitTitleBytes: 512,
  maxModelBytes: 256,
  maxPathFilters: 100,
  maxPathFilterBytes: 256,
  maxOutputFormats: 3,
  defaultMaxFiles: 200,
  maxMaxFiles: 1000,
  defaultMaxDiffBytes: 1024 * 1024,
  maxMaxDiffBytes: 4 * 1024 * 1024,
  maxPromptBytes: 256 * 1024,
  maxArtifactBytes: 2 * 1024 * 1024,
};

/**
 * Reports redactions by category for audit records and command telemetry.
 */
export type RedactionCounts = {
  apiKeyLike: number;
  bearer: number;
};

/**
 * Returned by redaction helpers with sanitized text and aggregate counts.
 */
export type RedactedText = {
  text: string;
  redactions: RedactionCounts;
};

const SECRET_REPLACEMENT = '[REDACTED_SECRET]';
const BEARER_REPLACEMENT = 'Bearer [REDACTED]';
const URL_CREDENTIAL_REPLACEMENT = '$1[REDACTED]@';

const BEARER_PATTERN = /\bBearer\s+[a-zA-Z0-9._~+/=-]+/gi;
const SECRET_LIKE_PATTERNS = [
  /\bsk-[a-zA-Z0-9_-]{20,}\b/g,
  /\bsk-or-v1-[a-zA-Z0-9_-]{20,}\b/g,
  /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[a-zA-Z0-9_]{20,}\b/g,
  /\bgithub_pat_[a-zA-Z0-9_]{20,}\b/g,
  /\bxox[baprs]-[a-zA-Z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
] as const;
const KEY_VALUE_SECRET_PATTERN =
  /((["']?)([A-Z0-9_-]+)\2\s*=\s*)((?:"[^"]*"|'[^']*'|[^\r\n,}]+))/gi;
const COLON_SECRET_PATTERN =
  /((["']?)([A-Z0-9_-]+)\2\s*:\s*)((?:"[^"]*"|'[^']*'|[^\r\n,}]+))/gi;
const URI_CREDENTIALS_PATTERN =
  /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
const EXACT_SECRET_KEY_NAMES = new Set([
  'apikey',
  'api_key',
  'auth',
  'authorization',
  'authtoken',
  'auth_token',
  'clientsecret',
  'client_secret',
  'credential',
  'credentials',
  'databaseurl',
  'database_url',
  'idtoken',
  'id_token',
  'password',
  'pass',
  'privatekey',
  'private_key',
  'refreshtoken',
  'refresh_token',
  'secret',
  'token',
]);

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

type BoundedStringOptions = {
  allowMultiline?: boolean;
};

function noControlCharacters(
  value: string,
  options: BoundedStringOptions = {}
): boolean {
  for (const character of value) {
    if (
      options.allowMultiline &&
      (character === '\n' || character === '\r' || character === '\t')
    ) {
      continue;
    }
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return false;
    }
  }
  return true;
}

function boundedString(
  label: string,
  maxBytes: number,
  options: BoundedStringOptions = {}
): z.ZodString {
  const controlCharacterMessage = options.allowMultiline
    ? `${label} must not contain control characters other than tab or newline`
    : `${label} must not contain control characters`;
  return z
    .string()
    .min(1)
    .max(maxBytes)
    .refine((value) => utf8ByteLength(value) <= maxBytes, {
      message: `${label} must be <= ${maxBytes} UTF-8 bytes`,
    })
    .refine((value) => noControlCharacters(value, options), {
      message: controlCharacterMessage,
    });
}

const SafeGitRefSchema = boundedString(
  'git ref',
  DEFAULT_REVIEW_SECURITY_LIMITS.maxGitRefBytes
).superRefine((value, context) => {
  const segments = value.split('/');
  const invalidReasons = [
    value.startsWith('-') ? 'must not start with "-"' : undefined,
    value.startsWith('/') || value.endsWith('/')
      ? 'must not start or end with "/"'
      : undefined,
    value.includes('..') ? 'must not contain ".."' : undefined,
    value.includes('@{') ? 'must not contain "@{"' : undefined,
    value === '@' ? 'must not be "@"' : undefined,
    value.endsWith('.') ? 'must not end with "."' : undefined,
    segments.some((segment) => segment.startsWith('.'))
      ? 'must not contain segments starting with "."'
      : undefined,
    segments.some((segment) => segment.endsWith('.lock'))
      ? 'must not contain segments ending with ".lock"'
      : undefined,
    value.includes('//') ? 'must not contain "//"' : undefined,
    /[\s~^:?*[\\]/.test(value)
      ? 'must not contain whitespace or Git ref control characters'
      : undefined,
  ].filter(Boolean);

  for (const reason of invalidReasons) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `git ref ${reason}`,
    });
  }
});

const CommitObjectIdSchema = boundedString(
  'commit sha',
  DEFAULT_REVIEW_SECURITY_LIMITS.maxGitRefBytes
).regex(/^[0-9a-fA-F]{7,64}$/, 'commit sha must be a Git object id');

const PathFilterSchema = boundedString(
  'path filter',
  DEFAULT_REVIEW_SECURITY_LIMITS.maxPathFilterBytes
).superRefine((value, context) => {
  const segments = value.split('/');
  const invalidReasons = [
    value.startsWith('/') ? 'must be repository-relative' : undefined,
    value.startsWith('~') ? 'must not start with "~"' : undefined,
    value.startsWith('!') ? 'must not use negation syntax' : undefined,
    value.startsWith(':(') ? 'must not use Git pathspec magic' : undefined,
    value.includes('\\') ? 'must use POSIX path separators' : undefined,
    value.includes('//') ? 'must not contain empty path segments' : undefined,
    segments.includes('..') ? 'must not contain ".." segments' : undefined,
    value === '.' ? 'must not target the repository root by "."' : undefined,
  ].filter(Boolean);

  for (const reason of invalidReasons) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `path filter ${reason}`,
    });
  }
});

/**
 * Validates the review target contract for working-tree, branch, commit, or
 * custom-instruction reviews.
 */
export const ReviewTargetSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('uncommittedChanges') }),
  z.strictObject({
    type: z.literal('baseBranch'),
    branch: SafeGitRefSchema,
  }),
  z.strictObject({
    type: z.literal('commit'),
    sha: CommitObjectIdSchema,
    title: boundedString(
      'commit title',
      DEFAULT_REVIEW_SECURITY_LIMITS.maxCommitTitleBytes
    ).optional(),
  }),
  z.strictObject({
    type: z.literal('custom'),
    instructions: boundedString(
      'custom instructions',
      DEFAULT_REVIEW_SECURITY_LIMITS.maxCustomInstructionsBytes,
      { allowMultiline: true }
    ),
  }),
]);

/**
 * Lists supported provider adapters for running review generation.
 */
export const ReviewProviderKindSchema = z.enum([
  'codexDelegate',
  'openaiCompatible',
]);

/**
 * Defines where review execution is allowed to run.
 */
export const ExecutionModeSchema = z.enum(['localTrusted', 'remoteSandbox']);
/**
 * Defines the lifecycle states shared by review service, worker, and durable store records.
 */
export const ReviewRunStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
/**
 * Defines provider reasoning-effort values accepted by review requests.
 */
export const ReasoningEffortSchema = z.enum([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);
/**
 * Defines artifact formats produced by review runs.
 */
export const OutputFormatSchema = z.enum(['sarif', 'json', 'markdown']);
const OutputFormatListSchema = z
  .array(OutputFormatSchema)
  .min(1)
  .max(DEFAULT_REVIEW_SECURITY_LIMITS.maxOutputFormats)
  .superRefine((formats, context) => {
    const seen = new Set<string>();
    for (const [index, format] of formats.entries()) {
      if (seen.has(format)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'outputFormats must not contain duplicates',
          path: [index],
        });
      }
      seen.add(format);
    }
  });
/**
 * Maps generated artifact formats to canonical HTTP content type headers with charset.
 */
export const ARTIFACT_CONTENT_TYPES = {
  json: 'application/json; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  sarif: 'application/json; charset=utf-8',
} as const satisfies Record<z.infer<typeof OutputFormatSchema>, string>;
/**
 * Defines minimum severity thresholds for reporting review findings.
 */
export const SeverityThresholdSchema = z.enum(['p0', 'p1', 'p2', 'p3']);
/**
 * Lists review run statuses that represent terminal states with no further transitions.
 */
export const TERMINAL_REVIEW_RUN_STATUSES = [
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly z.infer<typeof ReviewRunStatusSchema>[];
/**
 * Defines severity levels for provider diagnostics and readiness checks.
 */
export const ProviderDiagnosticSeveritySchema = z.enum([
  'info',
  'warning',
  'error',
]);
/**
 * Defines stable diagnostic codes emitted by provider validation and doctor checks.
 */
export const ProviderDiagnosticCodeSchema = z.enum([
  'binary_missing',
  'auth_missing',
  'auth_available',
  'invalid_model_id',
  'unsupported_reasoning_effort',
  'provider_unavailable',
  'configuration_error',
]);

/**
 * Validates the canonical review request contract after request-surface
 * hardening and before provider execution.
 */
export const ReviewRequestSchema = z.strictObject({
  cwd: boundedString('cwd', DEFAULT_REVIEW_SECURITY_LIMITS.maxCwdBytes),
  target: ReviewTargetSchema,
  provider: ReviewProviderKindSchema,
  executionMode: ExecutionModeSchema.default('localTrusted'),
  model: boundedString(
    'model',
    DEFAULT_REVIEW_SECURITY_LIMITS.maxModelBytes
  ).optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
  includePaths: z
    .array(PathFilterSchema)
    .max(DEFAULT_REVIEW_SECURITY_LIMITS.maxPathFilters)
    .optional(),
  excludePaths: z
    .array(PathFilterSchema)
    .max(DEFAULT_REVIEW_SECURITY_LIMITS.maxPathFilters)
    .optional(),
  maxFiles: z
    .number()
    .int()
    .positive()
    .max(DEFAULT_REVIEW_SECURITY_LIMITS.maxMaxFiles)
    .optional(),
  maxDiffBytes: z
    .number()
    .int()
    .positive()
    .max(DEFAULT_REVIEW_SECURITY_LIMITS.maxMaxDiffBytes)
    .optional(),
  outputFormats: OutputFormatListSchema,
  severityThreshold: SeverityThresholdSchema.optional(),
  detached: z.boolean().optional(),
});

const PrioritySchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

const LineRangeSchema = z
  .strictObject({
    start: z.number().int().positive(),
    end: z.number().int().positive(),
  })
  .superRefine((value, context) => {
    if (value.end < value.start) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'end must be >= start',
        path: ['end'],
      });
    }
  });

/**
 * Validates normalized review findings returned by providers.
 */
export const ReviewFindingSchema = z.strictObject({
  title: z.string().min(1),
  body: z.string().min(1),
  priority: PrioritySchema.optional(),
  confidenceScore: z.number().min(0).max(1),
  codeLocation: z.strictObject({
    absoluteFilePath: z.string().min(1),
    lineRange: LineRangeSchema,
  }),
  fingerprint: z.string().min(1),
});

/**
 * Validates the normalized review result returned to callers and rendered into artifacts.
 */
export const ReviewResultSchema = z.strictObject({
  findings: z.array(ReviewFindingSchema),
  overallCorrectness: z.enum([
    'patch is correct',
    'patch is incorrect',
    'unknown',
  ]),
  overallExplanation: z.string(),
  overallConfidenceScore: z.number().min(0).max(1),
  metadata: z.strictObject({
    provider: ReviewProviderKindSchema,
    modelResolved: z.string().min(1),
    executionMode: ExecutionModeSchema,
    promptPack: z.string().min(1),
    gitContext: z.strictObject({
      mode: z.string().min(1),
      baseRef: z.string().min(1).optional(),
      mergeBaseSha: z.string().min(1).optional(),
      commitSha: z.string().min(1).optional(),
    }),
    sandboxId: z.string().min(1).optional(),
  }),
});

/**
 * Validates the snake_case structured output expected from model providers.
 */
export const RawModelOutputSchema = z.strictObject({
  findings: z.array(
    z.strictObject({
      title: z.string().min(1),
      body: z.string().min(1),
      confidence_score: z.number().min(0).max(1),
      priority: PrioritySchema.optional(),
      code_location: z.strictObject({
        absolute_file_path: z.string().min(1),
        line_range: LineRangeSchema,
      }),
    })
  ),
  overall_correctness: z.enum(['patch is correct', 'patch is incorrect']),
  overall_explanation: z.string(),
  overall_confidence_score: z.number().min(0).max(1),
});

/**
 * Validates IDs that correlate lifecycle events, workflow runs, sandboxes, and commands.
 */
export const CorrelationIdsSchema = z.strictObject({
  reviewId: z.string().min(1),
  workflowRunId: z.string().min(1).optional(),
  sandboxId: z.string().min(1).optional(),
  commandId: z.string().min(1).optional(),
});

/**
 * Validates lifecycle event metadata used for replay ordering and correlation.
 */
export const LifecycleEventMetaSchema = z.strictObject({
  eventId: z.string().min(1),
  timestampMs: z.number().int().nonnegative(),
  correlation: CorrelationIdsSchema,
});

/**
 * Validates lifecycle events streamed and persisted for review run progress.
 */
export const LifecycleEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('enteredReviewMode'),
    review: z.string(),
    meta: LifecycleEventMetaSchema,
  }),
  z.strictObject({
    type: z.literal('progress'),
    message: z.string(),
    meta: LifecycleEventMetaSchema,
  }),
  z.strictObject({
    type: z.literal('exitedReviewMode'),
    review: z.string(),
    meta: LifecycleEventMetaSchema,
  }),
  z.strictObject({
    type: z.literal('artifactReady'),
    format: OutputFormatSchema,
    meta: LifecycleEventMetaSchema,
  }),
  z.strictObject({
    type: z.literal('failed'),
    message: z.string(),
    meta: LifecycleEventMetaSchema,
  }),
  z.strictObject({
    type: z.literal('cancelled'),
    meta: LifecycleEventMetaSchema,
  }),
]);

/**
 * Validates provider diagnostic records for readiness and request validation.
 */
export const ProviderDiagnosticSchema = z.strictObject({
  code: ProviderDiagnosticCodeSchema,
  ok: z.boolean(),
  severity: ProviderDiagnosticSeveritySchema,
  scope: z.string().min(1).optional(),
  detail: z.string().min(1),
  remediation: z.string().min(1).optional(),
});

/**
 * Defines whether a review request runs inline or as a detached async job.
 */
export const ReviewDeliverySchema = z.enum(['inline', 'detached']);

/**
 * Validates the start-review request body with delivery mode defaulting to inline.
 */
export const ReviewStartRequestSchema = z.strictObject({
  request: ReviewRequestSchema,
  delivery: ReviewDeliverySchema.default('inline'),
});

/**
 * Validates the canonical service error response body with a non-empty message.
 */
export const ReviewErrorResponseSchema = z.strictObject({
  error: z.string().min(1),
});

/**
 * Validates the start-review response with optional detached run ID and result.
 */
export const ReviewStartResponseSchema = z.strictObject({
  reviewId: z.string().min(1),
  status: ReviewRunStatusSchema,
  detachedRunId: z.string().min(1).optional(),
  result: ReviewResultSchema.optional(),
});

/**
 * Validates the review status response with timestamps and optional error or result.
 */
export const ReviewStatusResponseSchema = z.strictObject({
  reviewId: z.string().min(1),
  status: ReviewRunStatusSchema,
  error: z.string().min(1).optional(),
  result: ReviewResultSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

/**
 * Validates the cancel-review response with current run status and conflict marker.
 */
export const ReviewCancelResponseSchema = z.strictObject({
  reviewId: z.string().min(1),
  status: ReviewRunStatusSchema,
  cancelled: z.boolean().optional(),
});

/**
 * Validates event replay cursor parameters with bounded pagination defaulting to 100.
 */
export const ReviewEventCursorSchema = z.strictObject({
  reviewId: z.string().min(1),
  afterEventId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(500).default(100),
});

/**
 * Validates service-facing artifact metadata including format, content type, size, and creation time.
 */
export const ReviewArtifactMetadataSchema = z.strictObject({
  reviewId: z.string().min(1),
  format: OutputFormatSchema,
  contentType: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
});

/**
 * Tracks service-owned runtime capacity and heartbeat ownership for active runs.
 */
export const ReviewRunLeaseSchema = z.strictObject({
  owner: z.string().min(1),
  scopeKey: z.string().min(1),
  acquiredAt: z.number().int().nonnegative(),
  heartbeatAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});

const SandboxAuditRedactionsSchema = z.strictObject({
  apiKeyLike: z.number().int().nonnegative(),
  bearer: z.number().int().nonnegative(),
});

const CommandRunStatusSchema = z.enum([
  'completed',
  'failedToStart',
  'outputLimitExceeded',
  'timedOut',
  'cancelled',
]);

const CommandRunEventSchema = z.strictObject({
  type: z.enum([
    'started',
    'failedToStart',
    'stdoutLimitExceeded',
    'stderrLimitExceeded',
    'timedOut',
    'cancelled',
    'exited',
    'tempFileRead',
    'fileLimitExceeded',
    'tempDirCleaned',
    'tempDirCleanupFailed',
  ]),
  commandId: z.string().min(1),
  timestampMs: z.number().int().nonnegative(),
  message: z.string().min(1).optional(),
});

const CommandRunFileSchema = z.strictObject({
  key: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
  byteLength: z.number().int().nonnegative(),
  truncated: z.boolean(),
  redactions: SandboxAuditRedactionsSchema,
});

/**
 * Validates command execution requests sent from TypeScript packages to the runner helper.
 */
export const CommandRunInputSchema = z.strictObject({
  commandId: z.string().min(1).optional(),
  cmd: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
  stdin: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  cancelAfterMs: z.number().int().positive().optional(),
  maxStdoutBytes: z.number().int().positive().optional(),
  maxStderrBytes: z.number().int().positive().optional(),
  maxFileBytes: z.number().int().positive().optional(),
  maxTotalFileBytes: z.number().int().positive().optional(),
  tempDirPrefix: z.string().min(1).optional(),
  readFiles: z
    .array(
      z.strictObject({
        key: z.string().min(1),
        path: z.string().min(1),
        optional: z.boolean().optional(),
      })
    )
    .max(16),
});

/**
 * Validates structured command execution telemetry returned by the runner helper.
 */
export const CommandRunOutputSchema = z.strictObject({
  commandId: z.string().min(1),
  cmd: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1),
  status: CommandRunStatusSchema,
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  startedAtMs: z.number().int().nonnegative(),
  endedAtMs: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  outputBytes: z.number().int().nonnegative(),
  redactions: SandboxAuditRedactionsSchema,
  events: z.array(CommandRunEventSchema),
  files: z.array(CommandRunFileSchema),
});

/**
 * Validates sandbox audit records including policy, resource use, redactions, and commands.
 */
export const SandboxAuditSchema = z.strictObject({
  sandboxId: z.string().min(1),
  policy: z.strictObject({
    networkProfile: z.enum([
      'deny_all',
      'bootstrap_then_deny',
      'allowlist_only',
    ]),
    allowlistDomains: z.array(z.string()),
    commandAllowlistSize: z.number().int().nonnegative(),
    envAllowlistSize: z.number().int().nonnegative(),
  }),
  consumed: z.strictObject({
    commandCount: z.number().int().nonnegative(),
    wallTimeMs: z.number().int().nonnegative(),
    outputBytes: z.number().int().nonnegative(),
    artifactBytes: z.number().int().nonnegative(),
  }),
  redactions: SandboxAuditRedactionsSchema,
  commands: z.array(
    z.strictObject({
      commandId: z.string().min(1),
      cmd: z.string().min(1),
      args: z.array(z.string()),
      cwd: z.string().min(1),
      phase: z.enum(['bootstrap', 'runtime']).optional(),
      startedAtMs: z.number().int().nonnegative(),
      endedAtMs: z.number().int().nonnegative(),
      durationMs: z.number().int().nonnegative(),
      outputBytes: z.number().int().nonnegative(),
      redactions: SandboxAuditRedactionsSchema,
      exitCode: z.number().int(),
    })
  ),
});

/**
 * Validates durable store records for review runs, status, request, timestamps, and execution IDs.
 */
export const ReviewRunStoreRecordSchema = z.strictObject({
  reviewId: z.string().min(1),
  runId: z.string().min(1),
  status: ReviewRunStatusSchema,
  request: ReviewRequestSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().optional(),
  error: z.string().min(1).optional(),
  workflowRunId: z.string().min(1).optional(),
  sandboxId: z.string().min(1).optional(),
  lease: ReviewRunLeaseSchema.optional(),
  cancelRequestedAt: z.number().int().nonnegative().optional(),
});

/**
 * Validates durable store records for lifecycle events with sequence and creation time.
 */
export const ReviewEventStoreRecordSchema = z.strictObject({
  reviewId: z.string().min(1),
  eventId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  event: LifecycleEventSchema,
  createdAt: z.number().int().nonnegative(),
});

/**
 * Validates durable store records for generated artifacts, checksums, and storage keys.
 */
export const ReviewArtifactStoreRecordSchema = z.strictObject({
  reviewId: z.string().min(1),
  artifactId: z.string().min(1),
  format: OutputFormatSchema,
  contentType: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  storageKey: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
});

/**
 * Review target selected for a run.
 */
export type ReviewTarget = z.infer<typeof ReviewTargetSchema>;
/**
 * Provider adapter identifier.
 */
export type ReviewProviderKind = z.infer<typeof ReviewProviderKindSchema>;
/**
 * Review execution placement.
 */
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
/**
 * Durable review run lifecycle status.
 */
export type ReviewRunStatus = z.infer<typeof ReviewRunStatusSchema>;
/**
 * Provider reasoning-effort value.
 */
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
/**
 * Generated artifact format.
 */
export type OutputFormat = z.infer<typeof OutputFormatSchema>;
/**
 * Minimum finding severity threshold.
 */
export type SeverityThreshold = z.infer<typeof SeverityThresholdSchema>;
/**
 * Canonical review request payload.
 */
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;
/**
 * Normalized review finding.
 */
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
/**
 * Normalized review result.
 */
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
/**
 * Raw structured model output before normalization.
 */
export type RawModelOutput = z.infer<typeof RawModelOutputSchema>;
/**
 * Review lifecycle event.
 */
export type LifecycleEvent = z.infer<typeof LifecycleEventSchema>;
/**
 * Correlation identifiers shared across review telemetry.
 */
export type CorrelationIds = z.infer<typeof CorrelationIdsSchema>;
/**
 * Metadata attached to each lifecycle event.
 */
export type LifecycleEventMeta = z.infer<typeof LifecycleEventMetaSchema>;
/**
 * Provider diagnostic emitted by readiness or request checks.
 */
export type ProviderDiagnostic = z.infer<typeof ProviderDiagnosticSchema>;
/**
 * Delivery mode for the review service start endpoint.
 */
export type ReviewDelivery = z.infer<typeof ReviewDeliverySchema>;
/**
 * Request body accepted by the review service start endpoint.
 */
export type ReviewStartRequest = z.infer<typeof ReviewStartRequestSchema>;
/**
 * Error response returned by review service endpoints.
 */
export type ReviewErrorResponse = z.infer<typeof ReviewErrorResponseSchema>;
/**
 * Response returned by the review service start endpoint.
 */
export type ReviewStartResponse = z.infer<typeof ReviewStartResponseSchema>;
/**
 * Response returned by the review status endpoint.
 */
export type ReviewStatusResponse = z.infer<typeof ReviewStatusResponseSchema>;
/**
 * Response returned by the review cancellation endpoint.
 */
export type ReviewCancelResponse = z.infer<typeof ReviewCancelResponseSchema>;
/**
 * Cursor accepted when replaying review lifecycle events.
 */
export type ReviewEventCursor = z.infer<typeof ReviewEventCursorSchema>;
/**
 * Metadata describing a generated review artifact.
 */
export type ReviewArtifactMetadata = z.infer<
  typeof ReviewArtifactMetadataSchema
>;
/**
 * Describes persisted runtime lease ownership and heartbeat timestamps for a run.
 */
export type ReviewRunLease = z.infer<typeof ReviewRunLeaseSchema>;
/**
 * Command execution request accepted by the local runner helper.
 */
export type CommandRunInput = z.infer<typeof CommandRunInputSchema>;
/**
 * Structured command execution result emitted by the local runner helper.
 */
export type CommandRunOutput = z.infer<typeof CommandRunOutputSchema>;
/**
 * Sandbox execution policy, resource, redaction, and command audit record.
 */
export type SandboxAudit = z.infer<typeof SandboxAuditSchema>;
/**
 * Durable run-store record.
 */
export type ReviewRunStoreRecord = z.infer<typeof ReviewRunStoreRecordSchema>;
/**
 * Durable event-store record.
 */
export type ReviewEventStoreRecord = z.infer<
  typeof ReviewEventStoreRecordSchema
>;
/**
 * Durable artifact-store record.
 */
export type ReviewArtifactStoreRecord = z.infer<
  typeof ReviewArtifactStoreRecordSchema
>;

/**
 * Provider feature flags used to gate request options before execution.
 */
export type ReviewProviderCapabilities = {
  jsonSchemaOutput: boolean;
  reasoningControl: boolean;
  streaming: boolean;
  maxInputChars?: number;
};

/**
 * Inputs used when validating a request against provider capabilities.
 */
export type ReviewProviderValidationInput = {
  request: ReviewRequest;
  capabilities: ReviewProviderCapabilities;
};

/**
 * Defines the prompt, diff, request, and cancellation inputs passed to providers.
 */
export type ReviewProviderRunInput = {
  request: ReviewRequest;
  resolvedPrompt: string;
  rubric: string;
  normalizedDiffChunks: Array<{ file: string; patch: string }>;
  abortSignal?: AbortSignal;
};

/**
 * Normalized review provider result, optionally including command-run telemetry.
 */
export type ReviewProviderRunOutput = {
  raw: unknown;
  text: string;
  resolvedModel?: string;
  commandRun?: CommandRunOutput;
};

/**
 * Provider failure that carries the command-run payload that caused the error.
 */
export class ReviewProviderCommandRunError extends Error {
  readonly commandRun: CommandRunOutput;

  constructor(message: string, commandRun: CommandRunOutput) {
    super(message);
    this.name = 'ReviewProviderCommandRunError';
    this.commandRun = commandRun;
  }
}

/**
 * Extracts structured command-run telemetry from provider errors.
 *
 * @param error - Unknown error value thrown by a provider call.
 * @returns Validated command-run output when present, otherwise undefined.
 */
export function getReviewProviderCommandRun(
  error: unknown
): CommandRunOutput | undefined {
  if (error instanceof ReviewProviderCommandRunError) {
    return error.commandRun;
  }
  if (!error || typeof error !== 'object' || !('commandRun' in error)) {
    return undefined;
  }
  const parsed = CommandRunOutputSchema.safeParse(
    (error as { commandRun: unknown }).commandRun
  );
  return parsed.success ? parsed.data : undefined;
}

/**
 * Provider adapter interface implemented by local and OpenAI-compatible review runners.
 */
export interface ReviewProvider {
  id: ReviewProviderKind;
  capabilities(): ReviewProviderCapabilities;
  validateRequest?(input: ReviewProviderValidationInput): ProviderDiagnostic[];
  doctor?(): Promise<ProviderDiagnostic[]>;
  run(input: ReviewProviderRunInput): Promise<ReviewProviderRunOutput>;
}

function replaceAndCount(
  input: string,
  pattern: RegExp,
  replacement: string
): { text: string; count: number } {
  const count = input.match(pattern)?.length ?? 0;
  return {
    text: input.replaceAll(pattern, replacement),
    count,
  };
}

function isSecretKeyName(rawKey: string): boolean {
  const key = rawKey.replaceAll(/['"]/g, '').toLowerCase();
  const compact = key.replaceAll(/[^a-z0-9]/g, '');
  const tokens = key.split(/[^a-z0-9]+/).filter(Boolean);
  return (
    EXACT_SECRET_KEY_NAMES.has(key) ||
    EXACT_SECRET_KEY_NAMES.has(compact) ||
    compact.includes('apikey') ||
    compact.endsWith('token') ||
    compact.endsWith('secret') ||
    compact.endsWith('password') ||
    compact.endsWith('credential') ||
    tokens.includes('token') ||
    tokens.includes('secret') ||
    tokens.includes('password') ||
    tokens.includes('credential') ||
    tokens.includes('credentials')
  );
}

function redactedValueWithOriginalQuoting(value: string): string {
  const leadingWhitespace = value.match(/^\s*/)?.[0] ?? '';
  const trimmed = value.slice(leadingWhitespace.length);
  if (trimmed.startsWith('"')) {
    return `${leadingWhitespace}"${SECRET_REPLACEMENT}"`;
  }
  if (trimmed.startsWith("'")) {
    return `${leadingWhitespace}'${SECRET_REPLACEMENT}'`;
  }
  return `${leadingWhitespace}${SECRET_REPLACEMENT}`;
}

function redactDelimitedSecretValues(
  input: string,
  pattern: RegExp
): { text: string; count: number } {
  let count = 0;
  const text = input.replace(
    pattern,
    (
      match: string,
      prefix: string,
      _quote: string,
      key: string,
      value: string
    ) => {
      if (!isSecretKeyName(key)) {
        return match;
      }
      count += 1;
      return `${prefix}${redactedValueWithOriginalQuoting(value)}`;
    }
  );
  return { text, count };
}

/**
 * Adds redaction counts together without mutating either input object.
 *
 * @param left - Existing redaction counts.
 * @param right - Additional redaction counts.
 * @returns Combined redaction counts.
 */
export function mergeRedactionCounts(
  left: RedactionCounts,
  right: RedactionCounts
): RedactionCounts {
  return {
    apiKeyLike: left.apiKeyLike + right.apiKeyLike,
    bearer: left.bearer + right.bearer,
  };
}

/**
 * Redacts common secret forms from text before it is logged, persisted, or
 * included in generated review artifacts.
 *
 * @param input - Text that may contain provider, VCS, cloud, or credential values.
 * @returns Sanitized text with aggregate redaction counts.
 */
export function redactSensitiveText(input: string): RedactedText {
  const bearer = replaceAndCount(input, BEARER_PATTERN, BEARER_REPLACEMENT);
  let text = bearer.text;
  let apiKeyLike = 0;
  for (const pattern of SECRET_LIKE_PATTERNS) {
    const result = replaceAndCount(text, pattern, SECRET_REPLACEMENT);
    text = result.text;
    apiKeyLike += result.count;
  }
  const keyValue = redactDelimitedSecretValues(text, KEY_VALUE_SECRET_PATTERN);
  text = keyValue.text;
  apiKeyLike += keyValue.count;
  const colon = redactDelimitedSecretValues(text, COLON_SECRET_PATTERN);
  text = colon.text;
  apiKeyLike += colon.count;
  const uri = replaceAndCount(
    text,
    URI_CREDENTIALS_PATTERN,
    URL_CREDENTIAL_REPLACEMENT
  );
  text = uri.text;
  apiKeyLike += uri.count;
  return {
    text,
    redactions: {
      apiKeyLike,
      bearer: bearer.count,
    },
  };
}

/**
 * Redacts the human-facing message for an unknown error value.
 *
 * @param error - Error-like value from a catch block.
 * @param fallback - Safe message to use when the error has no message.
 * @returns Redacted error message.
 */
export function redactErrorMessage(
  error: unknown,
  fallback = 'internal error'
): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : fallback;
  return redactSensitiveText(message || fallback).text || fallback;
}

/**
 * Redacts secret-bearing text fields in a lifecycle event.
 *
 * @param event - Lifecycle event before persistence or streaming.
 * @returns A copy with user-visible text fields redacted.
 */
export function redactLifecycleEvent(event: LifecycleEvent): LifecycleEvent {
  switch (event.type) {
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return {
        ...event,
        review: redactSensitiveText(event.review).text,
      };
    case 'progress':
    case 'failed':
      return {
        ...event,
        message: redactSensitiveText(event.message).text,
      };
    case 'artifactReady':
    case 'cancelled':
      return event;
  }
}

/**
 * Redacts secret-bearing fields inside a normalized review result.
 *
 * @param result - Review result before artifact rendering or service response.
 * @returns Redacted review result and aggregate counts.
 */
export function redactReviewResult(result: ReviewResult): {
  result: ReviewResult;
  redactions: RedactionCounts;
} {
  let redactions: RedactionCounts = { apiKeyLike: 0, bearer: 0 };
  const redact = (value: string): string => {
    const sanitized = redactSensitiveText(value);
    redactions = mergeRedactionCounts(redactions, sanitized.redactions);
    return sanitized.text;
  };
  const sanitized: ReviewResult = {
    ...result,
    findings: result.findings.map((finding) => ({
      ...finding,
      title: redact(finding.title),
      body: redact(finding.body),
      codeLocation: {
        ...finding.codeLocation,
        absoluteFilePath: redact(finding.codeLocation.absoluteFilePath),
      },
      fingerprint: redact(finding.fingerprint),
    })),
    overallExplanation: redact(result.overallExplanation),
    metadata: {
      ...result.metadata,
      modelResolved: redact(result.metadata.modelResolved),
      promptPack: redact(result.metadata.promptPack),
      gitContext: {
        ...result.metadata.gitContext,
        ...(result.metadata.gitContext.baseRef
          ? { baseRef: redact(result.metadata.gitContext.baseRef) }
          : {}),
        ...(result.metadata.gitContext.mergeBaseSha
          ? { mergeBaseSha: redact(result.metadata.gitContext.mergeBaseSha) }
          : {}),
        ...(result.metadata.gitContext.commitSha
          ? { commitSha: redact(result.metadata.gitContext.commitSha) }
          : {}),
      },
      ...(result.metadata.sandboxId
        ? { sandboxId: redact(result.metadata.sandboxId) }
        : {}),
    },
  };
  return { result: sanitized, redactions };
}

/**
 * Redacts secret-bearing text fields in structured command-run telemetry.
 *
 * @param commandRun - Command-run output before persistence or event rendering.
 * @returns A copy with stdout, stderr, event messages, files, and arguments redacted.
 */
export function redactCommandRunOutput(
  commandRun: CommandRunOutput
): CommandRunOutput {
  let redactions = { ...commandRun.redactions };
  const redact = (value: string): string => {
    const sanitized = redactSensitiveText(value);
    redactions = mergeRedactionCounts(redactions, sanitized.redactions);
    return sanitized.text;
  };
  const cmd = redact(commandRun.cmd);
  const args = commandRun.args.map(redact);
  const cwd = redact(commandRun.cwd);
  const stdout = redact(commandRun.stdout);
  const stderr = redact(commandRun.stderr);
  const events = commandRun.events.map((event) => ({
    ...event,
    ...(event.message ? { message: redact(event.message) } : {}),
  }));
  const files = commandRun.files.map((file) => {
    const key = redact(file.key);
    const path = redact(file.path);
    const content = redactSensitiveText(file.content);
    redactions = mergeRedactionCounts(redactions, content.redactions);
    return {
      ...file,
      key,
      path,
      content: content.text,
      redactions: mergeRedactionCounts(file.redactions, content.redactions),
    };
  });
  return {
    ...commandRun,
    cmd,
    args,
    cwd,
    stdout,
    stderr,
    redactions,
    events,
    files,
  };
}

/**
 * Resolves partial limit overrides on top of the default review security caps.
 *
 * @param overrides - Optional stricter or environment-specific limits.
 * @returns Fully populated limit object.
 */
export function resolveReviewSecurityLimits(
  overrides: Partial<ReviewSecurityLimits> = {}
): ReviewSecurityLimits {
  const resolveLimit = (field: keyof ReviewSecurityLimits): number => {
    const value = overrides[field];
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.min(value, DEFAULT_REVIEW_SECURITY_LIMITS[field])
      : DEFAULT_REVIEW_SECURITY_LIMITS[field];
  };
  const resolved: ReviewSecurityLimits = {
    maxCwdBytes: resolveLimit('maxCwdBytes'),
    maxCustomInstructionsBytes: resolveLimit('maxCustomInstructionsBytes'),
    maxGitRefBytes: resolveLimit('maxGitRefBytes'),
    maxCommitTitleBytes: resolveLimit('maxCommitTitleBytes'),
    maxModelBytes: resolveLimit('maxModelBytes'),
    maxPathFilters: resolveLimit('maxPathFilters'),
    maxPathFilterBytes: resolveLimit('maxPathFilterBytes'),
    maxOutputFormats: resolveLimit('maxOutputFormats'),
    defaultMaxFiles: resolveLimit('defaultMaxFiles'),
    maxMaxFiles: resolveLimit('maxMaxFiles'),
    defaultMaxDiffBytes: resolveLimit('defaultMaxDiffBytes'),
    maxMaxDiffBytes: resolveLimit('maxMaxDiffBytes'),
    maxPromptBytes: resolveLimit('maxPromptBytes'),
    maxArtifactBytes: resolveLimit('maxArtifactBytes'),
  };
  return {
    ...resolved,
    defaultMaxFiles: Math.min(resolved.defaultMaxFiles, resolved.maxMaxFiles),
    defaultMaxDiffBytes: Math.min(
      resolved.defaultMaxDiffBytes,
      resolved.maxMaxDiffBytes
    ),
  };
}

function assertStringWithinSecurityLimit(
  value: string | undefined,
  label: string,
  maxBytes: number
): void {
  if (value !== undefined && utf8ByteLength(value) > maxBytes) {
    throw new Error(`${label} exceeds configured byte limit`);
  }
}

function assertPathFiltersWithinSecurityLimit(
  filters: string[] | undefined,
  label: string,
  limits: ReviewSecurityLimits
): void {
  if (filters === undefined) {
    return;
  }
  if (filters.length > limits.maxPathFilters) {
    throw new Error(`${label} exceeds configured path filter count limit`);
  }
  for (const filter of filters) {
    assertStringWithinSecurityLimit(
      filter,
      `${label} item`,
      limits.maxPathFilterBytes
    );
  }
}

/**
 * Enforces resolved security limits that can be stricter than static schema caps.
 *
 * @param request - Parsed review request to validate against resolved limits.
 * @param limits - Fully resolved security limits.
 */
export function assertReviewRequestWithinSecurityLimits(
  request: ReviewRequest,
  limits: ReviewSecurityLimits = DEFAULT_REVIEW_SECURITY_LIMITS
): void {
  assertStringWithinSecurityLimit(request.cwd, 'cwd', limits.maxCwdBytes);
  assertStringWithinSecurityLimit(request.model, 'model', limits.maxModelBytes);
  assertPathFiltersWithinSecurityLimit(
    request.includePaths,
    'includePaths',
    limits
  );
  assertPathFiltersWithinSecurityLimit(
    request.excludePaths,
    'excludePaths',
    limits
  );
  if (request.outputFormats.length > limits.maxOutputFormats) {
    throw new Error('outputFormats exceeds configured count limit');
  }
  switch (request.target.type) {
    case 'baseBranch':
      assertStringWithinSecurityLimit(
        request.target.branch,
        'target.branch',
        limits.maxGitRefBytes
      );
      break;
    case 'commit':
      assertStringWithinSecurityLimit(
        request.target.sha,
        'target.sha',
        limits.maxGitRefBytes
      );
      assertStringWithinSecurityLimit(
        request.target.title,
        'target.title',
        limits.maxCommitTitleBytes
      );
      break;
    case 'custom':
      assertStringWithinSecurityLimit(
        request.target.instructions,
        'target.instructions',
        limits.maxCustomInstructionsBytes
      );
      break;
  }
}

/**
 * Adds default diff caps to a parsed review request without changing explicit
 * caller-provided values.
 *
 * @param request - Parsed review request.
 * @param limits - Fully resolved security limits.
 * @returns Request with bounded diff defaults.
 */
export function withReviewRequestSecurityDefaults(
  request: ReviewRequest,
  limits: ReviewSecurityLimits = DEFAULT_REVIEW_SECURITY_LIMITS
): ReviewRequest {
  const maxFiles = Math.min(
    request.maxFiles ?? limits.defaultMaxFiles,
    limits.maxMaxFiles
  );
  const maxDiffBytes = Math.min(
    request.maxDiffBytes ?? limits.defaultMaxDiffBytes,
    limits.maxMaxDiffBytes
  );
  const bounded = {
    ...request,
    maxFiles,
    maxDiffBytes,
  };
  assertReviewRequestWithinSecurityLimits(bounded, limits);
  return bounded;
}

/**
 * Generated JSON Schema bundle used for cross-runtime contract parity.
 */
export type JsonSchemaSet = {
  outputFormat: unknown;
  reviewRunStatus: unknown;
  reviewRequest: unknown;
  reviewFinding: unknown;
  reviewResult: unknown;
  rawModelOutput: unknown;
  lifecycleEvent: unknown;
  providerDiagnostic: unknown;
  reviewStartRequest: unknown;
  reviewErrorResponse: unknown;
  reviewStartResponse: unknown;
  reviewStatusResponse: unknown;
  reviewCancelResponse: unknown;
  reviewEventCursor: unknown;
  reviewArtifactMetadata: unknown;
  commandRunInput: unknown;
  commandRunOutput: unknown;
  sandboxAudit: unknown;
  reviewRunStoreRecord: unknown;
  reviewEventStoreRecord: unknown;
  reviewArtifactStoreRecord: unknown;
};

const JSON_SCHEMA_OPTIONS = {
  io: 'input',
  target: 'draft-7',
} as const;

function toDraft7JsonSchema(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, JSON_SCHEMA_OPTIONS);
}

/**
 * Builds the committed JSON Schema bundle used by non-TypeScript contract tests.
 *
 * @returns Draft-7-compatible JSON Schema objects for exported review contracts.
 */
export function buildJsonSchemaSet(): JsonSchemaSet {
  return {
    outputFormat: toDraft7JsonSchema(OutputFormatSchema),
    reviewRunStatus: toDraft7JsonSchema(ReviewRunStatusSchema),
    reviewRequest: toDraft7JsonSchema(ReviewRequestSchema),
    reviewFinding: toDraft7JsonSchema(ReviewFindingSchema),
    reviewResult: toDraft7JsonSchema(ReviewResultSchema),
    rawModelOutput: toDraft7JsonSchema(RawModelOutputSchema),
    lifecycleEvent: toDraft7JsonSchema(LifecycleEventSchema),
    providerDiagnostic: toDraft7JsonSchema(ProviderDiagnosticSchema),
    reviewStartRequest: toDraft7JsonSchema(ReviewStartRequestSchema),
    reviewErrorResponse: toDraft7JsonSchema(ReviewErrorResponseSchema),
    reviewStartResponse: toDraft7JsonSchema(ReviewStartResponseSchema),
    reviewStatusResponse: toDraft7JsonSchema(ReviewStatusResponseSchema),
    reviewCancelResponse: toDraft7JsonSchema(ReviewCancelResponseSchema),
    reviewEventCursor: toDraft7JsonSchema(ReviewEventCursorSchema),
    reviewArtifactMetadata: toDraft7JsonSchema(ReviewArtifactMetadataSchema),
    commandRunInput: toDraft7JsonSchema(CommandRunInputSchema),
    commandRunOutput: toDraft7JsonSchema(CommandRunOutputSchema),
    sandboxAudit: toDraft7JsonSchema(SandboxAuditSchema),
    reviewRunStoreRecord: toDraft7JsonSchema(ReviewRunStoreRecordSchema),
    reviewEventStoreRecord: toDraft7JsonSchema(ReviewEventStoreRecordSchema),
    reviewArtifactStoreRecord: toDraft7JsonSchema(
      ReviewArtifactStoreRecordSchema
    ),
  };
}

/**
 * Checks whether a review run status represents a terminal state.
 *
 * @param status - The review run status to inspect.
 * @returns True when the status is completed, failed, or cancelled.
 */
export function isTerminalReviewRunStatus(status: ReviewRunStatus): boolean {
  return (TERMINAL_REVIEW_RUN_STATUSES as readonly ReviewRunStatus[]).includes(
    status
  );
}

/**
 * Parses and validates unknown input as a review request.
 *
 * @param input - Unknown value to validate.
 * @returns Parsed review request.
 */
export function parseReviewRequest(input: unknown): ReviewRequest {
  return ReviewRequestSchema.parse(input);
}

/**
 * Parses and validates provider model output before normalization.
 *
 * @param input - Unknown value to validate.
 * @returns Parsed raw model output.
 */
export function parseRawModelOutput(input: unknown): RawModelOutput {
  return RawModelOutputSchema.parse(input);
}

/**
 * Converts a severity threshold to the numeric priority scale.
 *
 * @param threshold - Severity threshold to convert.
 * @returns Numeric priority value where lower values are more severe.
 */
export function severityToPriority(
  threshold: SeverityThreshold
): 0 | 1 | 2 | 3 {
  switch (threshold) {
    case 'p0':
      return 0;
    case 'p1':
      return 1;
    case 'p2':
      return 2;
    case 'p3':
      return 3;
  }
}

/**
 * Checks whether any finding meets or exceeds the selected threshold.
 *
 * @param findings - Findings to inspect.
 * @param threshold - Minimum severity threshold to report.
 * @returns True when at least one finding is at or above the threshold.
 */
export function hasFindingsAtOrAboveThreshold(
  findings: ReviewFinding[],
  threshold: SeverityThreshold
): boolean {
  const maxPriority = severityToPriority(threshold);
  return findings.some((finding) => (finding.priority ?? 3) <= maxPriority);
}

/**
 * Converts one raw model finding into the normalized provider finding shape.
 *
 * @param input - Raw model finding to normalize.
 * @returns Normalized finding without a fingerprint.
 */
export function normalizeRawFinding(
  input: RawModelOutput['findings'][number]
): Omit<ReviewFinding, 'fingerprint'> {
  return {
    title: input.title,
    body: input.body,
    priority: input.priority,
    confidenceScore: input.confidence_score,
    codeLocation: {
      absoluteFilePath: input.code_location.absolute_file_path,
      lineRange: {
        start: input.code_location.line_range.start,
        end: input.code_location.line_range.end,
      },
    },
  };
}
