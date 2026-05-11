import { z } from 'zod';

export const ReviewTargetSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('uncommittedChanges') }),
  z.strictObject({
    type: z.literal('baseBranch'),
    branch: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal('commit'),
    sha: z.string().min(1),
    title: z.string().min(1).optional(),
  }),
  z.strictObject({
    type: z.literal('custom'),
    instructions: z.string().min(1),
  }),
]);

export const ReviewProviderKindSchema = z.enum([
  'codexDelegate',
  'openaiCompatible',
]);
export const ExecutionModeSchema = z.enum(['localTrusted', 'remoteSandbox']);
export const ReviewRunStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export const ReasoningEffortSchema = z.enum([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);
export const OutputFormatSchema = z.enum(['sarif', 'json', 'markdown']);
export const ARTIFACT_CONTENT_TYPES = {
  json: 'application/json; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  sarif: 'application/json; charset=utf-8',
} as const satisfies Record<z.infer<typeof OutputFormatSchema>, string>;
export const SeverityThresholdSchema = z.enum(['p0', 'p1', 'p2', 'p3']);
export const TERMINAL_REVIEW_RUN_STATUSES = [
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly z.infer<typeof ReviewRunStatusSchema>[];
export const ProviderDiagnosticSeveritySchema = z.enum([
  'info',
  'warning',
  'error',
]);
export const ProviderDiagnosticCodeSchema = z.enum([
  'binary_missing',
  'auth_missing',
  'auth_available',
  'invalid_model_id',
  'unsupported_reasoning_effort',
  'provider_unavailable',
  'configuration_error',
]);

export const ReviewRequestSchema = z.strictObject({
  cwd: z.string().min(1),
  target: ReviewTargetSchema,
  provider: ReviewProviderKindSchema,
  executionMode: ExecutionModeSchema.default('localTrusted'),
  model: z.string().min(1).optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
  includePaths: z.array(z.string().min(1)).optional(),
  excludePaths: z.array(z.string().min(1)).optional(),
  maxFiles: z.number().int().positive().optional(),
  maxDiffBytes: z.number().int().positive().optional(),
  outputFormats: z.array(OutputFormatSchema).min(1),
  severityThreshold: SeverityThresholdSchema.optional(),
  detached: z.boolean().optional(),
});

const PrioritySchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export const ReviewFindingSchema = z.strictObject({
  title: z.string().min(1),
  body: z.string().min(1),
  priority: PrioritySchema.optional(),
  confidenceScore: z.number().min(0).max(1),
  codeLocation: z.strictObject({
    absoluteFilePath: z.string().min(1),
    lineRange: z
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
      }),
  }),
  fingerprint: z.string().min(1),
});

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
  }),
});

export const RawModelOutputSchema = z.strictObject({
  findings: z.array(
    z.strictObject({
      title: z.string().min(1),
      body: z.string().min(1),
      confidence_score: z.number().min(0).max(1),
      priority: PrioritySchema.optional(),
      code_location: z.strictObject({
        absolute_file_path: z.string().min(1),
        line_range: z.strictObject({
          start: z.number().int().positive(),
          end: z.number().int().positive(),
        }),
      }),
    })
  ),
  overall_correctness: z.enum(['patch is correct', 'patch is incorrect']),
  overall_explanation: z.string(),
  overall_confidence_score: z.number().min(0).max(1),
});

export const CorrelationIdsSchema = z.strictObject({
  reviewId: z.string().min(1),
  workflowRunId: z.string().min(1).optional(),
  sandboxId: z.string().min(1).optional(),
  commandId: z.string().min(1).optional(),
});

export const LifecycleEventMetaSchema = z.strictObject({
  eventId: z.string().min(1),
  timestampMs: z.number().int().nonnegative(),
  correlation: CorrelationIdsSchema,
});

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

export const ProviderDiagnosticSchema = z.strictObject({
  code: ProviderDiagnosticCodeSchema,
  ok: z.boolean(),
  severity: ProviderDiagnosticSeveritySchema,
  detail: z.string().min(1),
  remediation: z.string().min(1).optional(),
});

export const ReviewDeliverySchema = z.enum(['inline', 'detached']);

export const ReviewStartRequestSchema = z.strictObject({
  request: ReviewRequestSchema,
  delivery: ReviewDeliverySchema.default('inline'),
});

export const ReviewErrorResponseSchema = z.strictObject({
  error: z.string().min(1),
});

export const ReviewStartResponseSchema = z.strictObject({
  reviewId: z.string().min(1),
  status: ReviewRunStatusSchema,
  detachedRunId: z.string().min(1).optional(),
  result: ReviewResultSchema.optional(),
});

export const ReviewStatusResponseSchema = z.strictObject({
  reviewId: z.string().min(1),
  status: ReviewRunStatusSchema,
  error: z.string().min(1).optional(),
  result: ReviewResultSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const ReviewCancelResponseSchema = z.strictObject({
  reviewId: z.string().min(1),
  status: ReviewRunStatusSchema,
  cancelled: z.boolean().optional(),
});

export const ReviewEventCursorSchema = z.strictObject({
  reviewId: z.string().min(1),
  afterEventId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(500).default(100),
});

export const ReviewArtifactMetadataSchema = z.strictObject({
  reviewId: z.string().min(1),
  format: OutputFormatSchema,
  contentType: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
});

const SandboxAuditRedactionsSchema = z.strictObject({
  apiKeyLike: z.number().int().nonnegative(),
  bearer: z.number().int().nonnegative(),
});

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
      startedAtMs: z.number().int().nonnegative(),
      endedAtMs: z.number().int().nonnegative(),
      durationMs: z.number().int().nonnegative(),
      outputBytes: z.number().int().nonnegative(),
      redactions: SandboxAuditRedactionsSchema,
      exitCode: z.number().int(),
    })
  ),
});

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
});

export const ReviewEventStoreRecordSchema = z.strictObject({
  reviewId: z.string().min(1),
  eventId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  event: LifecycleEventSchema,
  createdAt: z.number().int().nonnegative(),
});

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

export type ReviewTarget = z.infer<typeof ReviewTargetSchema>;
export type ReviewProviderKind = z.infer<typeof ReviewProviderKindSchema>;
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
export type ReviewRunStatus = z.infer<typeof ReviewRunStatusSchema>;
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export type OutputFormat = z.infer<typeof OutputFormatSchema>;
export type SeverityThreshold = z.infer<typeof SeverityThresholdSchema>;
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
export type RawModelOutput = z.infer<typeof RawModelOutputSchema>;
export type LifecycleEvent = z.infer<typeof LifecycleEventSchema>;
export type CorrelationIds = z.infer<typeof CorrelationIdsSchema>;
export type LifecycleEventMeta = z.infer<typeof LifecycleEventMetaSchema>;
export type ProviderDiagnostic = z.infer<typeof ProviderDiagnosticSchema>;
export type ReviewDelivery = z.infer<typeof ReviewDeliverySchema>;
export type ReviewStartRequest = z.infer<typeof ReviewStartRequestSchema>;
export type ReviewErrorResponse = z.infer<typeof ReviewErrorResponseSchema>;
export type ReviewStartResponse = z.infer<typeof ReviewStartResponseSchema>;
export type ReviewStatusResponse = z.infer<typeof ReviewStatusResponseSchema>;
export type ReviewCancelResponse = z.infer<typeof ReviewCancelResponseSchema>;
export type ReviewEventCursor = z.infer<typeof ReviewEventCursorSchema>;
export type ReviewArtifactMetadata = z.infer<
  typeof ReviewArtifactMetadataSchema
>;
export type SandboxAudit = z.infer<typeof SandboxAuditSchema>;
export type ReviewRunStoreRecord = z.infer<typeof ReviewRunStoreRecordSchema>;
export type ReviewEventStoreRecord = z.infer<
  typeof ReviewEventStoreRecordSchema
>;
export type ReviewArtifactStoreRecord = z.infer<
  typeof ReviewArtifactStoreRecordSchema
>;

export type ReviewProviderCapabilities = {
  jsonSchemaOutput: boolean;
  reasoningControl: boolean;
  streaming: boolean;
  maxInputChars?: number;
};

export type ReviewProviderValidationInput = {
  request: ReviewRequest;
  capabilities: ReviewProviderCapabilities;
};

export type ReviewProviderRunInput = {
  request: ReviewRequest;
  resolvedPrompt: string;
  rubric: string;
  normalizedDiffChunks: Array<{ file: string; patch: string }>;
};

export type ReviewProviderRunOutput = {
  raw: unknown;
  text: string;
  resolvedModel?: string;
};

export interface ReviewProvider {
  id: ReviewProviderKind;
  capabilities(): ReviewProviderCapabilities;
  validateRequest?(input: ReviewProviderValidationInput): ProviderDiagnostic[];
  doctor?(): Promise<ProviderDiagnostic[]>;
  run(input: ReviewProviderRunInput): Promise<ReviewProviderRunOutput>;
}

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
    sandboxAudit: toDraft7JsonSchema(SandboxAuditSchema),
    reviewRunStoreRecord: toDraft7JsonSchema(ReviewRunStoreRecordSchema),
    reviewEventStoreRecord: toDraft7JsonSchema(ReviewEventStoreRecordSchema),
    reviewArtifactStoreRecord: toDraft7JsonSchema(
      ReviewArtifactStoreRecordSchema
    ),
  };
}

export function isTerminalReviewRunStatus(status: ReviewRunStatus): boolean {
  return TERMINAL_REVIEW_RUN_STATUSES.some(
    (terminalStatus) => terminalStatus === status
  );
}

export function parseReviewRequest(input: unknown): ReviewRequest {
  return ReviewRequestSchema.parse(input);
}

export function parseRawModelOutput(input: unknown): RawModelOutput {
  return RawModelOutputSchema.parse(input);
}

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

export function hasFindingsAtOrAboveThreshold(
  findings: ReviewFinding[],
  threshold: SeverityThreshold
): boolean {
  const maxPriority = severityToPriority(threshold);
  return findings.some((finding) => (finding.priority ?? 3) <= maxPriority);
}

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
