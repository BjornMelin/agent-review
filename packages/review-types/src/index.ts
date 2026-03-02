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
export const ReasoningEffortSchema = z.enum([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);
export const OutputFormatSchema = z.enum(['sarif', 'json', 'markdown']);
export const SeverityThresholdSchema = z.enum(['p0', 'p1', 'p2', 'p3']);
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

export type ReviewTarget = z.infer<typeof ReviewTargetSchema>;
export type ReviewProviderKind = z.infer<typeof ReviewProviderKindSchema>;
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
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
  reviewRequest: unknown;
  reviewFinding: unknown;
  reviewResult: unknown;
  rawModelOutput: unknown;
  lifecycleEvent: unknown;
  providerDiagnostic: unknown;
};

export function buildJsonSchemaSet(): JsonSchemaSet {
  return {
    reviewRequest: z.toJSONSchema(ReviewRequestSchema, { target: 'draft-7' }),
    reviewFinding: z.toJSONSchema(ReviewFindingSchema, { target: 'draft-7' }),
    reviewResult: z.toJSONSchema(ReviewResultSchema, { target: 'draft-7' }),
    rawModelOutput: z.toJSONSchema(RawModelOutputSchema, { target: 'draft-7' }),
    lifecycleEvent: z.toJSONSchema(LifecycleEventSchema, { target: 'draft-7' }),
    providerDiagnostic: z.toJSONSchema(ProviderDiagnosticSchema, {
      target: 'draft-7',
    }),
  };
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
