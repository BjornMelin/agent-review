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
  /\brat_[a-zA-Z0-9_-]{6,}_[a-zA-Z0-9_-]{20,}\b/g,
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
 * Lists review target variants accepted by request and summary contracts.
 */
export const ReviewTargetTypeSchema = z.enum([
  'uncommittedChanges',
  'baseBranch',
  'commit',
  'custom',
]);

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
const GitHubNumericIdSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const GitHubOwnerSchema = boundedString('GitHub owner', 39).regex(
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/,
  'GitHub owner must be a valid user or organization login'
);
const GitHubRepositoryNameSchema = boundedString(
  'GitHub repository name',
  100
).regex(
  /^(?!.*\.git$)[A-Za-z0-9._-]+$/,
  'GitHub repository name must use GitHub-safe characters and must not include .git suffix'
);
const GitHubPermissionLevelSchema = z.enum(['read', 'write', 'admin']);
const GitHubRepositoryVisibilitySchema = z.enum([
  'public',
  'private',
  'internal',
]);

/**
 * Lists service authorization scopes enforced by hosted review routes.
 */
export const ReviewAuthScopeSchema = z.enum([
  'review:start',
  'review:read',
  'review:cancel',
  'review:publish',
  'token:admin',
]);

const ReviewAuthScopeListSchema = z
  .array(ReviewAuthScopeSchema)
  .min(1)
  .max(16)
  .superRefine((scopes, context) => {
    const seen = new Set<string>();
    for (const [index, scope] of scopes.entries()) {
      if (seen.has(scope)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'authorization scopes must not contain duplicates',
          path: [index],
        });
      }
      seen.add(scope);
    }
  });

const REPOSITORY_TARGET_FIELDS = [
  'pullRequestNumber',
  'ref',
  'commitSha',
] as const;

type RepositoryTargetInput = Partial<
  Record<(typeof REPOSITORY_TARGET_FIELDS)[number], unknown>
>;

function validateRepositoryTargetSelection(
  input: RepositoryTargetInput,
  context: z.RefinementCtx
): void {
  const present = REPOSITORY_TARGET_FIELDS.filter(
    (field) => input[field] !== undefined
  );
  if (present.length <= 1) {
    return;
  }
  const conflictingField = present[1] ?? present[0] ?? 'ref';
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message:
      'repository target must specify at most one of pullRequestNumber, ref, or commitSha',
    path: [conflictingField],
  });
}

/**
 * Defines a GitHub repository selected by a hosted review start request.
 */
export const ReviewRepositorySelectionSchema = z
  .strictObject({
    provider: z.literal('github').default('github'),
    owner: GitHubOwnerSchema,
    name: GitHubRepositoryNameSchema,
    repositoryId: GitHubNumericIdSchema.optional(),
    installationId: GitHubNumericIdSchema.optional(),
    pullRequestNumber: z.number().int().positive().optional(),
    ref: SafeGitRefSchema.optional(),
    commitSha: CommitObjectIdSchema.optional(),
  })
  .superRefine(validateRepositoryTargetSelection);

/**
 * Defines the effective GitHub repository authorization persisted with a run.
 */
export const ReviewRepositoryAuthorizationSchema = z
  .strictObject({
    provider: z.literal('github'),
    repositoryId: GitHubNumericIdSchema,
    installationId: GitHubNumericIdSchema,
    owner: GitHubOwnerSchema,
    name: GitHubRepositoryNameSchema,
    fullName: boundedString('GitHub repository full name', 140),
    visibility: GitHubRepositoryVisibilitySchema,
    permissions: z.record(z.string(), GitHubPermissionLevelSchema),
    pullRequestNumber: z.number().int().positive().optional(),
    ref: SafeGitRefSchema.optional(),
    commitSha: CommitObjectIdSchema.optional(),
  })
  .superRefine(validateRepositoryTargetSelection);

/**
 * Defines the authenticated principal responsible for a hosted review action.
 */
export const ReviewAuthPrincipalSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('githubUser'),
    githubUserId: GitHubNumericIdSchema,
    login: GitHubOwnerSchema,
  }),
  z.strictObject({
    type: z.literal('serviceToken'),
    tokenId: boundedString('service token id', 64),
    tokenPrefix: boundedString('service token prefix', 80),
    name: boundedString('service token name', 128).optional(),
  }),
]);

/**
 * Defines the repository-scoped authorization snapshot persisted for a run.
 */
export const ReviewRunAuthorizationSchema = z.strictObject({
  principal: ReviewAuthPrincipalSchema,
  repository: ReviewRepositoryAuthorizationSchema,
  scopes: ReviewAuthScopeListSchema,
  actor: boundedString('authorization actor', 160),
  requestHash: boundedString('request hash', 128),
  authorizedAt: z.number().int().nonnegative(),
});
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
 * Classifies provider policy and runtime failures without exposing raw upstream errors.
 */
export const ProviderFailureClassSchema = z.enum([
  'none',
  'policy',
  'budget',
  'auth',
  'rate_limit',
  'timeout',
  'provider_unavailable',
  'invalid_response',
  'cancelled',
  'unknown',
]);

/**
 * Describes whether a routed provider policy enforces data-retention constraints.
 */
export const ProviderRetentionPolicySchema = z.enum([
  'zdrEnforced',
  'providerRetained',
  'unknown',
  'byokUnverified',
]);

/**
 * Captures provider-reported token and cost totals without raw provider payloads.
 */
export const ProviderUsageSchema = z.strictObject({
  status: z.enum(['reported', 'unknown']),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  marketCostUsd: z.number().nonnegative().optional(),
});

/**
 * Records one routed provider attempt, including sanitized status, latency, and
 * optional usage evidence.
 */
export const ProviderAttemptTelemetrySchema = z.strictObject({
  route: z.string().min(1),
  model: z.string().min(1),
  provider: z.string().min(1).optional(),
  status: z.enum(['success', 'failed', 'skipped']),
  latencyMs: z.number().int().nonnegative(),
  failureClass: ProviderFailureClassSchema.optional(),
  errorCode: z.string().min(1).optional(),
  retryable: z.boolean().optional(),
  generationId: z.string().min(1).optional(),
  usage: ProviderUsageSchema.optional(),
});

/**
 * Captures policy decisions, fallback evidence, and cost/latency telemetry for provider runs.
 */
export const ProviderPolicyTelemetrySchema = z.strictObject({
  policyVersion: z.string().min(1),
  requestedModel: z.string().min(1).optional(),
  resolvedModel: z.string().min(1),
  route: z.string().min(1),
  finalProvider: z.string().min(1).optional(),
  fallbackOrder: z.array(z.string().min(1)),
  fallbackUsed: z.boolean(),
  maxInputChars: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  retention: ProviderRetentionPolicySchema,
  zdrRequired: z.boolean(),
  disallowPromptTraining: z.boolean(),
  failureClass: ProviderFailureClassSchema,
  totalLatencyMs: z.number().int().nonnegative(),
  attempts: z.array(ProviderAttemptTelemetrySchema).min(1),
  usage: ProviderUsageSchema,
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
    providerTelemetry: ProviderPolicyTelemetrySchema.optional(),
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
  repository: ReviewRepositorySelectionSchema.optional(),
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
 * Defines the GitHub publication channels owned by the hosted service.
 */
export const ReviewPublicationChannelSchema = z.enum([
  'checkRun',
  'sarif',
  'pullRequestComment',
]);

/**
 * Defines the terminal state of one GitHub publication side effect.
 */
export const ReviewPublicationStatusSchema = z.enum([
  'published',
  'skipped',
  'unsupported',
  'failed',
]);

/**
 * Validates persisted and service-facing GitHub publication state.
 */
export const ReviewPublicationRecordSchema = z.strictObject({
  publicationId: z.string().min(1),
  reviewId: z.string().min(1),
  channel: ReviewPublicationChannelSchema,
  targetKey: z.string().min(1),
  status: ReviewPublicationStatusSchema,
  externalId: z.string().min(1).optional(),
  externalUrl: z.string().min(1).optional(),
  marker: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

/**
 * Defines reviewer-owned triage states for immutable provider findings.
 */
export const ReviewFindingTriageStatusSchema = z.enum([
  'open',
  'accepted',
  'false-positive',
  'fixed',
  'published',
  'dismissed',
  'ignored',
]);

const ReviewFindingFingerprintSchema = boundedString(
  'finding fingerprint',
  512
);
const ReviewFindingTriageNoteSchema = z
  .string()
  .max(4096)
  .refine((value) => noControlCharacters(value, { allowMultiline: true }), {
    message:
      'finding triage note must not contain control characters other than tab or newline',
  });

/**
 * Validates mutable reviewer state attached to one immutable finding.
 */
export const ReviewFindingTriageRecordSchema = z.strictObject({
  reviewId: z.string().min(1),
  fingerprint: ReviewFindingFingerprintSchema,
  status: ReviewFindingTriageStatusSchema,
  note: ReviewFindingTriageNoteSchema.optional(),
  actor: z.string().min(1).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

/**
 * Validates append-only finding triage audit records.
 */
export const ReviewFindingTriageAuditRecordSchema = z.strictObject({
  auditId: z.string().min(1),
  reviewId: z.string().min(1),
  fingerprint: ReviewFindingFingerprintSchema,
  fromStatus: ReviewFindingTriageStatusSchema.optional(),
  toStatus: ReviewFindingTriageStatusSchema,
  note: ReviewFindingTriageNoteSchema.optional(),
  actor: z.string().min(1).optional(),
  createdAt: z.number().int().nonnegative(),
});

/**
 * Validates triage mutations from Review Room.
 */
export const ReviewFindingTriageUpdateRequestSchema = z
  .strictObject({
    status: ReviewFindingTriageStatusSchema.optional(),
    note: ReviewFindingTriageNoteSchema.nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.status === undefined && value.note === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'status or note is required',
      });
    }
  });

/**
 * Validates triage list responses used by status and Review Room APIs.
 */
export const ReviewFindingTriageListResponseSchema = z.strictObject({
  reviewId: z.string().min(1),
  items: z.array(ReviewFindingTriageRecordSchema),
  audit: z.array(ReviewFindingTriageAuditRecordSchema),
});

/**
 * Validates one triage mutation response.
 */
export const ReviewFindingTriageUpdateResponseSchema = z.strictObject({
  reviewId: z.string().min(1),
  record: ReviewFindingTriageRecordSchema,
  audit: ReviewFindingTriageAuditRecordSchema,
});

/**
 * Defines side-effect-free GitHub publication preview actions.
 */
export const ReviewPublicationPreviewActionSchema = z.enum([
  'create',
  'update',
  'reuse',
  'delete',
  'skip',
  'unsupported',
  'blocked',
]);

/**
 * Validates one planned or existing GitHub publication effect.
 */
export const ReviewPublicationPreviewItemSchema = z.strictObject({
  channel: ReviewPublicationChannelSchema,
  targetKey: z.string().min(1),
  action: ReviewPublicationPreviewActionSchema,
  message: z.string().min(1),
  externalId: z.string().min(1).optional(),
  externalUrl: z.string().min(1).optional(),
  marker: z.string().min(1).optional(),
  fingerprint: ReviewFindingFingerprintSchema.optional(),
  priority: PrioritySchema.optional(),
  path: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  bodyPreview: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Validates the GitHub target resolved for publication preview.
 */
export const ReviewPublicationPreviewTargetSchema = z.strictObject({
  owner: GitHubOwnerSchema,
  repo: GitHubRepositoryNameSchema,
  repositoryId: GitHubNumericIdSchema,
  installationId: GitHubNumericIdSchema,
  commitSha: CommitObjectIdSchema,
  ref: SafeGitRefSchema.optional(),
  pullRequestNumber: z.number().int().positive().optional(),
  pullRequestHeadSha: CommitObjectIdSchema.optional(),
});

/**
 * Validates the side-effect-free publish preview response.
 */
export const ReviewPublishPreviewResponseSchema = z.strictObject({
  reviewId: z.string().min(1),
  target: ReviewPublicationPreviewTargetSchema,
  items: z.array(ReviewPublicationPreviewItemSchema),
  existingPublications: z.array(ReviewPublicationRecordSchema),
  summary: z.strictObject({
    checkRunAction: ReviewPublicationPreviewActionSchema.optional(),
    sarifAction: ReviewPublicationPreviewActionSchema.optional(),
    pullRequestCommentCount: z.number().int().nonnegative(),
    blockedCount: z.number().int().nonnegative(),
  }),
});

/**
 * Summarizes the repository context shown in run lists and operational views.
 */
export const ReviewRunRepositorySummarySchema = z.strictObject({
  provider: z.literal('github'),
  owner: GitHubOwnerSchema,
  name: GitHubRepositoryNameSchema,
  fullName: boundedString('GitHub repository full name', 140),
  repositoryId: GitHubNumericIdSchema,
  installationId: GitHubNumericIdSchema,
  visibility: GitHubRepositoryVisibilitySchema,
  pullRequestNumber: z.number().int().positive().optional(),
  ref: SafeGitRefSchema.optional(),
  commitSha: CommitObjectIdSchema.optional(),
});

/**
 * Summarizes the execution request without exposing host-local paths.
 */
export const ReviewRunRequestSummarySchema = z.strictObject({
  provider: ReviewProviderKindSchema,
  executionMode: ExecutionModeSchema,
  targetType: ReviewTargetTypeSchema,
  outputFormats: OutputFormatListSchema,
  model: boundedString(
    'model',
    DEFAULT_REVIEW_SECURITY_LIMITS.maxModelBytes
  ).optional(),
});

/**
 * Defines the compact run shape used by Review Room lists and status summaries.
 */
export const ReviewRunSummarySchema = z.strictObject({
  reviewId: z.string().min(1),
  status: ReviewRunStatusSchema,
  request: ReviewRunRequestSummarySchema,
  repository: ReviewRunRepositorySummarySchema.optional(),
  error: z.string().min(1).optional(),
  findingCount: z.number().int().nonnegative(),
  artifactFormats: z.array(OutputFormatSchema),
  publicationCount: z.number().int().nonnegative(),
  modelResolved: z.string().min(1).optional(),
  providerTelemetry: ProviderPolicyTelemetrySchema.optional(),
  detachedRunId: z.string().min(1).optional(),
  workflowRunId: z.string().min(1).optional(),
  sandboxId: z.string().min(1).optional(),
  cancelRequestedAt: z.number().int().nonnegative().optional(),
  completedAt: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

/**
 * Defines query controls for the hosted review run list endpoint.
 */
export const ReviewRunListQuerySchema = z
  .strictObject({
    status: ReviewRunStatusSchema.optional(),
    limit: z.number().int().positive().max(100).default(25),
    cursor: z.string().min(1).optional(),
    owner: GitHubOwnerSchema.optional(),
    name: GitHubRepositoryNameSchema.optional(),
  })
  .superRefine((value, context) => {
    if ((value.owner === undefined) !== (value.name === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'owner and name must be provided together',
        path: value.owner === undefined ? ['owner'] : ['name'],
      });
    }
  });

/**
 * Defines the paginated hosted review run list response.
 */
export const ReviewRunListResponseSchema = z.strictObject({
  runs: z.array(ReviewRunSummarySchema),
  nextCursor: z.string().min(1).optional(),
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
 * Validates the review status response with timestamps and optional error or result.
 */
export const ReviewStatusResponseSchema = z.strictObject({
  reviewId: z.string().min(1),
  status: ReviewRunStatusSchema,
  error: z.string().min(1).optional(),
  result: ReviewResultSchema.optional(),
  summary: ReviewRunSummarySchema.optional(),
  publications: z.array(ReviewPublicationRecordSchema).optional(),
  triage: z.array(ReviewFindingTriageRecordSchema).optional(),
  triageAudit: z.array(ReviewFindingTriageAuditRecordSchema).optional(),
  artifacts: z.array(ReviewArtifactMetadataSchema).optional(),
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
 * Validates the publish-review response with one row per attempted channel or comment.
 */
export const ReviewPublishResponseSchema = z.strictObject({
  reviewId: z.string().min(1),
  status: z.enum(['published', 'partial', 'failed', 'skipped']),
  publications: z.array(ReviewPublicationRecordSchema),
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
  authorization: ReviewRunAuthorizationSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().optional(),
  error: z.string().min(1).optional(),
  detachedRunId: z.string().min(1).optional(),
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
 * Review target discriminant used by compact run summaries.
 */
export type ReviewTargetType = z.infer<typeof ReviewTargetTypeSchema>;
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
 * Hosted service authorization scope.
 */
export type ReviewAuthScope = z.infer<typeof ReviewAuthScopeSchema>;
/**
 * GitHub repository selected by a hosted review start request.
 */
export type ReviewRepositorySelection = z.infer<
  typeof ReviewRepositorySelectionSchema
>;
/**
 * Effective GitHub repository authorization persisted with a run.
 */
export type ReviewRepositoryAuthorization = z.infer<
  typeof ReviewRepositoryAuthorizationSchema
>;
/**
 * Authenticated hosted service principal.
 */
export type ReviewAuthPrincipal = z.infer<typeof ReviewAuthPrincipalSchema>;
/**
 * Repository-scoped authorization snapshot persisted with a run.
 */
export type ReviewRunAuthorization = z.infer<
  typeof ReviewRunAuthorizationSchema
>;
/**
 * Canonical review request payload.
 */
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;
/**
 * Normalized review finding.
 */
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
/**
 * Redacted provider failure classification.
 */
export type ProviderFailureClass = z.infer<typeof ProviderFailureClassSchema>;
/**
 * Provider data-retention policy classification.
 */
export type ProviderRetentionPolicy = z.infer<
  typeof ProviderRetentionPolicySchema
>;
/**
 * Provider usage and cost data when exposed by an upstream SDK.
 */
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;
/**
 * Single provider/model attempt telemetry.
 */
export type ProviderAttemptTelemetry = z.infer<
  typeof ProviderAttemptTelemetrySchema
>;
/**
 * Provider policy and runtime telemetry persisted with review results.
 */
export type ProviderPolicyTelemetry = z.infer<
  typeof ProviderPolicyTelemetrySchema
>;
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
 * GitHub publication side-effect channel.
 */
export type ReviewPublicationChannel = z.infer<
  typeof ReviewPublicationChannelSchema
>;
/**
 * Terminal state for one GitHub publication side effect.
 */
export type ReviewPublicationStatus = z.infer<
  typeof ReviewPublicationStatusSchema
>;
/**
 * Persisted and service-facing GitHub publication state.
 */
export type ReviewPublicationRecord = z.infer<
  typeof ReviewPublicationRecordSchema
>;
/**
 * Reviewer-owned triage state for one finding.
 */
export type ReviewFindingTriageStatus = z.infer<
  typeof ReviewFindingTriageStatusSchema
>;
/**
 * Mutable reviewer state attached to one immutable finding.
 */
export type ReviewFindingTriageRecord = z.infer<
  typeof ReviewFindingTriageRecordSchema
>;
/**
 * Append-only audit event for finding triage state changes.
 */
export type ReviewFindingTriageAuditRecord = z.infer<
  typeof ReviewFindingTriageAuditRecordSchema
>;
/**
 * Request body accepted by the finding triage mutation endpoint.
 */
export type ReviewFindingTriageUpdateRequest = z.infer<
  typeof ReviewFindingTriageUpdateRequestSchema
>;
/**
 * Response returned by the finding triage list endpoint.
 */
export type ReviewFindingTriageListResponse = z.infer<
  typeof ReviewFindingTriageListResponseSchema
>;
/**
 * Response returned by the finding triage mutation endpoint.
 */
export type ReviewFindingTriageUpdateResponse = z.infer<
  typeof ReviewFindingTriageUpdateResponseSchema
>;
/**
 * Side-effect-free GitHub publication preview action.
 */
export type ReviewPublicationPreviewAction = z.infer<
  typeof ReviewPublicationPreviewActionSchema
>;
/**
 * One planned or existing GitHub publication effect.
 */
export type ReviewPublicationPreviewItem = z.infer<
  typeof ReviewPublicationPreviewItemSchema
>;
/**
 * Response returned by the publish preview endpoint.
 */
export type ReviewPublishPreviewResponse = z.infer<
  typeof ReviewPublishPreviewResponseSchema
>;
/**
 * Repository context shown in run lists and operational views.
 */
export type ReviewRunRepositorySummary = z.infer<
  typeof ReviewRunRepositorySummarySchema
>;
/**
 * Request context shown in run lists and operational views.
 */
export type ReviewRunRequestSummary = z.infer<
  typeof ReviewRunRequestSummarySchema
>;
/**
 * Compact hosted review run row.
 */
export type ReviewRunSummary = z.infer<typeof ReviewRunSummarySchema>;
/**
 * Query controls accepted by the hosted review run list endpoint.
 */
export type ReviewRunListQuery = z.infer<typeof ReviewRunListQuerySchema>;
/**
 * Paginated hosted review run list response.
 */
export type ReviewRunListResponse = z.infer<typeof ReviewRunListResponseSchema>;
/**
 * Response returned by the review publication endpoint.
 */
export type ReviewPublishResponse = z.infer<typeof ReviewPublishResponseSchema>;
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
  providerTelemetry?: ProviderPolicyTelemetry;
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

function redactProviderAttemptTelemetry(
  attempt: ProviderAttemptTelemetry,
  redact: (value: string) => string
): ProviderAttemptTelemetry {
  return {
    route: redact(attempt.route),
    model: redact(attempt.model),
    status: attempt.status,
    latencyMs: attempt.latencyMs,
    ...(attempt.provider ? { provider: redact(attempt.provider) } : {}),
    ...(attempt.failureClass ? { failureClass: attempt.failureClass } : {}),
    ...(attempt.errorCode ? { errorCode: redact(attempt.errorCode) } : {}),
    ...(attempt.retryable === undefined
      ? {}
      : { retryable: attempt.retryable }),
    ...(attempt.generationId
      ? { generationId: redact(attempt.generationId) }
      : {}),
    ...(attempt.usage ? { usage: { ...attempt.usage } } : {}),
  };
}

function redactProviderPolicyTelemetry(
  telemetry: ProviderPolicyTelemetry,
  redact: (value: string) => string
): ProviderPolicyTelemetry {
  return {
    policyVersion: redact(telemetry.policyVersion),
    resolvedModel: redact(telemetry.resolvedModel),
    route: redact(telemetry.route),
    fallbackOrder: telemetry.fallbackOrder.map((model) => redact(model)),
    fallbackUsed: telemetry.fallbackUsed,
    maxInputChars: telemetry.maxInputChars,
    maxOutputTokens: telemetry.maxOutputTokens,
    timeoutMs: telemetry.timeoutMs,
    maxAttempts: telemetry.maxAttempts,
    retention: telemetry.retention,
    zdrRequired: telemetry.zdrRequired,
    disallowPromptTraining: telemetry.disallowPromptTraining,
    failureClass: telemetry.failureClass,
    totalLatencyMs: telemetry.totalLatencyMs,
    attempts: telemetry.attempts.map((attempt) =>
      redactProviderAttemptTelemetry(attempt, redact)
    ),
    usage: { ...telemetry.usage },
    ...(telemetry.requestedModel
      ? { requestedModel: redact(telemetry.requestedModel) }
      : {}),
    ...(telemetry.finalProvider
      ? { finalProvider: redact(telemetry.finalProvider) }
      : {}),
  };
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
      ...(result.metadata.providerTelemetry
        ? {
            providerTelemetry: redactProviderPolicyTelemetry(
              result.metadata.providerTelemetry,
              redact
            ),
          }
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
 * @throws Error - When the request exceeds configured size, path, or authorization limits.
 */
export function assertReviewRequestWithinSecurityLimits(
  request: ReviewRequest,
  limits: ReviewSecurityLimits = DEFAULT_REVIEW_SECURITY_LIMITS
): void {
  if (request.maxFiles !== undefined && request.maxFiles > limits.maxMaxFiles) {
    throw new Error('maxFiles exceeds configured limit');
  }
  if (
    request.maxDiffBytes !== undefined &&
    request.maxDiffBytes > limits.maxMaxDiffBytes
  ) {
    throw new Error('maxDiffBytes exceeds configured byte limit');
  }
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
  reviewTargetType: unknown;
  reviewRequest: unknown;
  reviewRepositorySelection: unknown;
  reviewRunAuthorization: unknown;
  reviewFinding: unknown;
  providerFailureClass: unknown;
  providerRetentionPolicy: unknown;
  providerUsage: unknown;
  providerAttemptTelemetry: unknown;
  providerPolicyTelemetry: unknown;
  reviewResult: unknown;
  rawModelOutput: unknown;
  lifecycleEvent: unknown;
  providerDiagnostic: unknown;
  reviewStartRequest: unknown;
  reviewErrorResponse: unknown;
  reviewStartResponse: unknown;
  reviewStatusResponse: unknown;
  reviewCancelResponse: unknown;
  reviewPublicationRecord: unknown;
  reviewFindingTriageStatus: unknown;
  reviewFindingTriageRecord: unknown;
  reviewFindingTriageAuditRecord: unknown;
  reviewFindingTriageUpdateRequest: unknown;
  reviewFindingTriageListResponse: unknown;
  reviewFindingTriageUpdateResponse: unknown;
  reviewPublicationPreviewAction: unknown;
  reviewPublicationPreviewItem: unknown;
  reviewPublicationPreviewTarget: unknown;
  reviewPublishPreviewResponse: unknown;
  reviewRunRepositorySummary: unknown;
  reviewRunRequestSummary: unknown;
  reviewRunSummary: unknown;
  reviewRunListQuery: unknown;
  reviewRunListResponse: unknown;
  reviewPublishResponse: unknown;
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

type JsonSchemaObject = Record<string, unknown>;

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addUniqueItemsToAuthScopeArrays(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    for (const item of schema) {
      addUniqueItemsToAuthScopeArrays(item);
    }
    return schema;
  }
  if (!isJsonSchemaObject(schema)) {
    return schema;
  }

  const items = schema.items;
  if (isJsonSchemaObject(items) && Array.isArray(items.enum)) {
    const authScopes = new Set(ReviewAuthScopeSchema.options);
    const enumValues = items.enum;
    if (
      enumValues.length === authScopes.size &&
      enumValues.every(
        (value): value is ReviewAuthScope =>
          typeof value === 'string' && authScopes.has(value as ReviewAuthScope)
      )
    ) {
      schema.uniqueItems = true;
    }
  }

  for (const value of Object.values(schema)) {
    addUniqueItemsToAuthScopeArrays(value);
  }
  return schema;
}

function addRepositoryTargetExclusivity(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    for (const item of schema) {
      addRepositoryTargetExclusivity(item);
    }
    return schema;
  }
  if (!isJsonSchemaObject(schema)) {
    return schema;
  }

  const properties = schema.properties;
  if (
    isJsonSchemaObject(properties) &&
    REPOSITORY_TARGET_FIELDS.every((field) => field in properties) &&
    !('repo' in properties)
  ) {
    schema.not = {
      anyOf: [
        { required: ['pullRequestNumber', 'ref'] },
        { required: ['pullRequestNumber', 'commitSha'] },
        { required: ['ref', 'commitSha'] },
      ],
    };
  }

  for (const value of Object.values(schema)) {
    addRepositoryTargetExclusivity(value);
  }
  return schema;
}

function toDraft7JsonSchema(schema: z.ZodType): unknown {
  return addRepositoryTargetExclusivity(
    addUniqueItemsToAuthScopeArrays(z.toJSONSchema(schema, JSON_SCHEMA_OPTIONS))
  );
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
    reviewTargetType: toDraft7JsonSchema(ReviewTargetTypeSchema),
    reviewRequest: toDraft7JsonSchema(ReviewRequestSchema),
    reviewRepositorySelection: toDraft7JsonSchema(
      ReviewRepositorySelectionSchema
    ),
    reviewRunAuthorization: toDraft7JsonSchema(ReviewRunAuthorizationSchema),
    reviewFinding: toDraft7JsonSchema(ReviewFindingSchema),
    providerFailureClass: toDraft7JsonSchema(ProviderFailureClassSchema),
    providerRetentionPolicy: toDraft7JsonSchema(ProviderRetentionPolicySchema),
    providerUsage: toDraft7JsonSchema(ProviderUsageSchema),
    providerAttemptTelemetry: toDraft7JsonSchema(
      ProviderAttemptTelemetrySchema
    ),
    providerPolicyTelemetry: toDraft7JsonSchema(ProviderPolicyTelemetrySchema),
    reviewResult: toDraft7JsonSchema(ReviewResultSchema),
    rawModelOutput: toDraft7JsonSchema(RawModelOutputSchema),
    lifecycleEvent: toDraft7JsonSchema(LifecycleEventSchema),
    providerDiagnostic: toDraft7JsonSchema(ProviderDiagnosticSchema),
    reviewStartRequest: toDraft7JsonSchema(ReviewStartRequestSchema),
    reviewErrorResponse: toDraft7JsonSchema(ReviewErrorResponseSchema),
    reviewStartResponse: toDraft7JsonSchema(ReviewStartResponseSchema),
    reviewStatusResponse: toDraft7JsonSchema(ReviewStatusResponseSchema),
    reviewCancelResponse: toDraft7JsonSchema(ReviewCancelResponseSchema),
    reviewPublicationRecord: toDraft7JsonSchema(ReviewPublicationRecordSchema),
    reviewFindingTriageStatus: toDraft7JsonSchema(
      ReviewFindingTriageStatusSchema
    ),
    reviewFindingTriageRecord: toDraft7JsonSchema(
      ReviewFindingTriageRecordSchema
    ),
    reviewFindingTriageAuditRecord: toDraft7JsonSchema(
      ReviewFindingTriageAuditRecordSchema
    ),
    reviewFindingTriageUpdateRequest: toDraft7JsonSchema(
      ReviewFindingTriageUpdateRequestSchema
    ),
    reviewFindingTriageListResponse: toDraft7JsonSchema(
      ReviewFindingTriageListResponseSchema
    ),
    reviewFindingTriageUpdateResponse: toDraft7JsonSchema(
      ReviewFindingTriageUpdateResponseSchema
    ),
    reviewPublicationPreviewAction: toDraft7JsonSchema(
      ReviewPublicationPreviewActionSchema
    ),
    reviewPublicationPreviewItem: toDraft7JsonSchema(
      ReviewPublicationPreviewItemSchema
    ),
    reviewPublicationPreviewTarget: toDraft7JsonSchema(
      ReviewPublicationPreviewTargetSchema
    ),
    reviewPublishPreviewResponse: toDraft7JsonSchema(
      ReviewPublishPreviewResponseSchema
    ),
    reviewRunRepositorySummary: toDraft7JsonSchema(
      ReviewRunRepositorySummarySchema
    ),
    reviewRunRequestSummary: toDraft7JsonSchema(ReviewRunRequestSummarySchema),
    reviewRunSummary: toDraft7JsonSchema(ReviewRunSummarySchema),
    reviewRunListQuery: toDraft7JsonSchema(ReviewRunListQuerySchema),
    reviewRunListResponse: toDraft7JsonSchema(ReviewRunListResponseSchema),
    reviewPublishResponse: toDraft7JsonSchema(ReviewPublishResponseSchema),
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
