import { createGateway, type GatewayProviderOptions } from '@ai-sdk/gateway';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  type ProviderAttemptTelemetry,
  type ProviderDiagnostic,
  type ProviderFailureClass,
  type ProviderPolicyTelemetry,
  type ProviderRetentionPolicy,
  type ProviderUsage,
  RawModelOutputSchema,
  type ReviewProvider,
  type ReviewProviderCapabilities,
  type ReviewProviderRunInput,
  type ReviewProviderRunOutput,
  type ReviewProviderValidationInput,
} from '@review-agent/review-types';
import { generateText, Output } from 'ai';

/**
 * Configures the OpenAI-compatible provider registry for route factories, model policies, and defaults.
 */
export type OpenAICompatibleProviderOptions = {
  defaultModelId?: string;
  capabilities: ReviewProviderCapabilities;
  modelPolicies: readonly OpenAICompatibleModelPolicy[];
  routes: readonly OpenAICompatibleRouteConfig[];
};

/**
 * Defines a Vercel AI Gateway route and its optional endpoint overrides.
 */
export type GatewayRouteConfig = {
  id: string;
  kind: 'gateway';
  displayName: string;
  apiKeyEnv: string;
  apiKey?: string | undefined;
  baseURL?: string | undefined;
};

/**
 * Defines an OpenAI-compatible chat route for provider-hosted model APIs.
 */
export type OpenAICompatibleChatRouteConfig = {
  id: string;
  kind: 'openaiCompatibleChat';
  displayName: string;
  apiKeyEnv: string;
  apiKey?: string | undefined;
  baseURL: string;
  headers?: Record<string, string> | undefined;
  supportsStructuredOutputs?: boolean | undefined;
};

/**
 * Describes a provider route that can resolve allowlisted routed model IDs.
 */
export type OpenAICompatibleRouteConfig =
  | GatewayRouteConfig
  | OpenAICompatibleChatRouteConfig;

/**
 * Captures the allowlisted routing, fallback, budget, timeout, and retention
 * controls for one Gateway or OpenRouter model.
 */
export type OpenAICompatibleModelPolicy = {
  id: string;
  route: string;
  policyVersion: string;
  fallbackModelIds: readonly string[];
  maxInputChars: number;
  maxOutputTokens: number;
  timeoutMs: number;
  maxAttempts: number;
  retention: ProviderRetentionPolicy;
  zdrRequired: boolean;
  disallowPromptTraining: boolean;
  gateway?: Pick<
    GatewayProviderOptions,
    'only' | 'order' | 'sort' | 'providerTimeouts'
  >;
};

type TextModel = Parameters<typeof generateText>[0]['model'];
type LanguageModelFactory = (modelId: string) => TextModel;
type ResolvedRouteConfig = OpenAICompatibleRouteConfig & {
  apiKey: string | undefined;
};
type ParsedModelPolicy = {
  route: ResolvedRouteConfig;
  modelId: string;
  routedModelId: string;
  policy: OpenAICompatibleModelPolicy;
};
type ProviderFallbackErrorOptions = {
  providerAttempts: readonly ProviderAttemptTelemetry[];
  lastFailureClass: ProviderFailureClass;
};

function cloneProviderAttemptTelemetry(
  attempt: ProviderAttemptTelemetry
): ProviderAttemptTelemetry {
  return {
    ...attempt,
    ...(attempt.usage ? { usage: { ...attempt.usage } } : {}),
  };
}

/**
 * Preserves sanitized provider-attempt telemetry when every routed attempt fails.
 */
export class ProviderFallbackError extends Error {
  readonly providerAttempts: ProviderAttemptTelemetry[];
  readonly lastFailureClass: ProviderFailureClass;

  constructor(message: string, options: ProviderFallbackErrorOptions) {
    super(message);
    this.name = 'ProviderFallbackError';
    this.providerAttempts = options.providerAttempts.map(
      cloneProviderAttemptTelemetry
    );
    this.lastFailureClass = options.lastFailureClass;
  }
}

function buildReviewInput(input: ReviewProviderRunInput): string {
  const chunks = input.normalizedDiffChunks
    .map((chunk, index) => {
      return `### Diff Chunk ${index + 1}: ${chunk.file}\n${chunk.patch}`;
    })
    .join('\n\n');

  return [
    'Review target instructions:',
    input.resolvedPrompt,
    '',
    'Git diff chunks to review:',
    chunks,
  ].join('\n');
}

function nonEmptySecret(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveRouteApiKey(
  route: OpenAICompatibleRouteConfig
): string | undefined {
  return (
    nonEmptySecret(route.apiKey) ?? nonEmptySecret(process.env[route.apiKeyEnv])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return undefined;
}

function optionalInteger(value: unknown): number | undefined {
  const parsed = optionalNumber(value);
  return parsed === undefined ? undefined : Math.floor(parsed);
}

function statusCodeFor(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  return optionalInteger(error.statusCode ?? error.status);
}

function errorName(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  return typeof error.name === 'string' ? error.name : undefined;
}

function retryableFor(error: unknown): boolean | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  return typeof error.isRetryable === 'boolean' ? error.isRetryable : undefined;
}

function classifyProviderError(error: unknown): ProviderFailureClass {
  const name = errorName(error);
  if (name === 'TimeoutError' || name === 'GatewayTimeoutError') {
    return 'timeout';
  }
  if (name === 'AbortError') {
    return 'cancelled';
  }
  if (
    name === 'AI_NoSuchModelError' ||
    name === 'AI_NoSuchProviderError' ||
    name === 'GatewayModelNotFoundError'
  ) {
    return 'policy';
  }
  const statusCode = statusCodeFor(error);
  if (statusCode === 401 || statusCode === 403) {
    return 'auth';
  }
  if (statusCode === 408 || statusCode === 504) {
    return 'timeout';
  }
  if (statusCode === 429) {
    return 'rate_limit';
  }
  if (statusCode !== undefined && statusCode >= 500) {
    return 'provider_unavailable';
  }
  if (statusCode !== undefined && statusCode >= 400) {
    return 'invalid_response';
  }
  return 'unknown';
}

function safeErrorCode(error: unknown): string {
  const name = errorName(error);
  if (name) {
    return name;
  }
  const statusCode = statusCodeFor(error);
  return statusCode === undefined ? 'unknown' : `http_${statusCode}`;
}

function extractGatewayMetadata(
  providerMetadata: unknown
): Record<string, unknown> | undefined {
  if (!isRecord(providerMetadata)) {
    return undefined;
  }
  const gateway = providerMetadata.gateway;
  return isRecord(gateway) ? gateway : undefined;
}

function extractFinalProvider(providerMetadata: unknown): string | undefined {
  const gateway = extractGatewayMetadata(providerMetadata);
  const routing = gateway && isRecord(gateway.routing) ? gateway.routing : {};
  const finalProvider = routing.finalProvider ?? routing.resolvedProvider;
  return typeof finalProvider === 'string' && finalProvider
    ? finalProvider
    : undefined;
}

function extractGenerationId(providerMetadata: unknown): string | undefined {
  const gateway = extractGatewayMetadata(providerMetadata);
  return typeof gateway?.generationId === 'string' && gateway.generationId
    ? gateway.generationId
    : undefined;
}

function extractProviderUsage(result: unknown): ProviderUsage {
  const resultRecord = isRecord(result) ? result : {};
  const usage = isRecord(resultRecord.totalUsage)
    ? resultRecord.totalUsage
    : isRecord(resultRecord.usage)
      ? resultRecord.usage
      : {};
  const gateway = extractGatewayMetadata(resultRecord.providerMetadata);
  const costUsd = optionalNumber(gateway?.cost);
  const marketCostUsd = optionalNumber(gateway?.marketCost);
  const inputTokens = optionalInteger(usage.inputTokens);
  const outputTokens = optionalInteger(usage.outputTokens);
  const totalTokens = optionalInteger(usage.totalTokens);
  const outputTokenDetails = isRecord(usage.outputTokenDetails)
    ? usage.outputTokenDetails
    : {};
  const inputTokenDetails = isRecord(usage.inputTokenDetails)
    ? usage.inputTokenDetails
    : {};
  const reasoningTokens = optionalInteger(outputTokenDetails.reasoningTokens);
  const cachedInputTokens = optionalInteger(inputTokenDetails.cacheReadTokens);
  const usageReported =
    inputTokens !== undefined ||
    outputTokens !== undefined ||
    totalTokens !== undefined ||
    costUsd !== undefined ||
    marketCostUsd !== undefined;

  return {
    status: usageReported ? 'reported' : 'unknown',
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(marketCostUsd === undefined ? {} : { marketCostUsd }),
  };
}

function buildGatewayProviderOptions(
  route: ResolvedRouteConfig,
  policy: OpenAICompatibleModelPolicy
): { gateway: GatewayProviderOptions } | undefined {
  if (route.kind !== 'gateway') {
    return undefined;
  }
  const gateway: GatewayProviderOptions = {
    ...(policy.gateway ?? {}),
    zeroDataRetention: policy.zdrRequired,
    disallowPromptTraining: policy.disallowPromptTraining,
    tags: ['review-agent', `policy:${policy.policyVersion}`],
  };
  return { gateway };
}

function retentionCompatible(
  requested: OpenAICompatibleModelPolicy,
  fallback: OpenAICompatibleModelPolicy
): boolean {
  if (requested.zdrRequired && fallback.retention !== 'zdrEnforced') {
    return false;
  }
  if (requested.disallowPromptTraining && !fallback.disallowPromptTraining) {
    return false;
  }
  return true;
}

function attemptLatencyMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

/**
 * Runs structured reviews through policy-checked OpenAI-compatible model routes.
 */
export class OpenAICompatibleReviewProvider implements ReviewProvider {
  id = 'openaiCompatible' as const;
  private readonly defaultModelId: string | undefined;
  private readonly capabilitiesPolicy: ReviewProviderCapabilities;
  private readonly factories = new Map<string, LanguageModelFactory>();
  private readonly modelPolicies = new Map<
    string,
    OpenAICompatibleModelPolicy
  >();
  private readonly routes = new Map<string, ResolvedRouteConfig>();

  constructor(options: OpenAICompatibleProviderOptions) {
    this.defaultModelId = options.defaultModelId;
    this.capabilitiesPolicy = options.capabilities;
    for (const policy of options.modelPolicies) {
      this.modelPolicies.set(policy.id, policy);
    }

    for (const route of options.routes) {
      const apiKey = resolveRouteApiKey(route);
      const resolvedRoute = { ...route, apiKey };
      this.routes.set(route.id, resolvedRoute);
      if (route.kind === 'gateway') {
        const gatewayOptions: { apiKey?: string; baseURL?: string } = {};
        if (apiKey) {
          gatewayOptions.apiKey = apiKey;
        }
        if (route.baseURL) {
          gatewayOptions.baseURL = route.baseURL;
        }
        const provider = createGateway(gatewayOptions);
        this.factories.set(route.id, (modelId) => provider(modelId));
      } else {
        const providerOptions: {
          baseURL: string;
          name: string;
          apiKey?: string;
          headers?: Record<string, string>;
          supportsStructuredOutputs: boolean;
        } = {
          baseURL: route.baseURL,
          name: route.id,
          supportsStructuredOutputs: route.supportsStructuredOutputs ?? true,
        };
        if (apiKey) {
          providerOptions.apiKey = apiKey;
        }
        if (route.headers) {
          providerOptions.headers = route.headers;
        }
        const provider = createOpenAICompatible(providerOptions);
        this.factories.set(route.id, (modelId) => provider.chatModel(modelId));
      }
    }
  }

  capabilities(): ReviewProviderCapabilities {
    return { ...this.capabilitiesPolicy };
  }

  private parseModelId(
    modelId: string
  ): ParsedModelPolicy | ProviderDiagnostic {
    const separator = modelId.indexOf(':');
    if (separator < 1 || separator === modelId.length - 1) {
      return {
        code: 'invalid_model_id',
        ok: false,
        severity: 'error',
        detail: `invalid model id "${modelId}". Expected "provider:model".`,
        remediation:
          'Use routed model ids like "gateway:openai/gpt-5" or "openrouter:openai/gpt-5".',
      };
    }

    const routeId = modelId.slice(0, separator);
    const route = this.routes.get(routeId);
    if (!route) {
      return {
        code: 'configuration_error',
        ok: false,
        severity: 'error',
        scope: routeId,
        detail: `unsupported provider "${routeId}" for openaiCompatible`,
        remediation: `Use one of: ${[...this.routes.keys()].join('|')}.`,
      };
    }

    const providerModelId = modelId.slice(separator + 1).trim();
    if (!providerModelId) {
      return {
        code: 'invalid_model_id',
        ok: false,
        severity: 'error',
        scope: routeId,
        detail: `invalid model id "${modelId}". Model segment is empty.`,
        remediation: `Use a non-empty ${routeId}:<model> identifier.`,
      };
    }
    const routedModelId = `${route.id}:${providerModelId}`;
    const policy = this.modelPolicies.get(routedModelId);
    if (!policy) {
      return {
        code: 'invalid_model_id',
        ok: false,
        severity: 'error',
        scope: routeId,
        detail: `model "${routedModelId}" is not in the provider policy catalog.`,
        remediation:
          'Use `review-agent models --json` to select an allowlisted model.',
      };
    }

    return {
      route,
      modelId: providerModelId,
      routedModelId,
      policy,
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
          'openaiCompatible does not currently accept reasoning-effort controls',
        remediation:
          'Omit --reasoning-effort until provider support is implemented.',
      });
      return diagnostics;
    }

    const resolvedModelId = input.request.model ?? this.defaultModelId;
    if (!resolvedModelId) {
      diagnostics.push({
        code: 'configuration_error',
        ok: false,
        severity: 'error',
        detail: 'openaiCompatible requires a routed model id',
        remediation:
          'Create providers through the provider registry or provide a defaultModelId option.',
      });
      return diagnostics;
    }
    const parsed = this.parseModelId(resolvedModelId);
    if ('code' in parsed) {
      diagnostics.push(parsed);
      return diagnostics;
    }

    if (!parsed.route.apiKey) {
      diagnostics.push({
        code: 'auth_missing',
        ok: false,
        severity: 'error',
        scope: parsed.route.id,
        detail: `missing ${parsed.route.displayName} API key`,
        remediation: `Set ${parsed.route.apiKeyEnv} or provide an apiKey for ${parsed.route.id}.`,
      });
    }
    return diagnostics;
  }

  async doctor(): Promise<ProviderDiagnostic[]> {
    const diagnostics: ProviderDiagnostic[] = [];
    for (const route of this.routes.values()) {
      diagnostics.push(
        route.apiKey
          ? {
              code: 'auth_available',
              ok: true,
              severity: 'info',
              scope: route.id,
              detail: `${route.displayName} auth detected`,
            }
          : {
              code: 'auth_missing',
              ok: false,
              severity: 'error',
              scope: route.id,
              detail: `${route.apiKeyEnv} is not configured`,
              remediation: `Set ${route.apiKeyEnv} for ${route.id}:* model routing.`,
            }
      );
    }
    return diagnostics;
  }

  async run(input: ReviewProviderRunInput): Promise<ReviewProviderRunOutput> {
    const resolvedModelId = input.request.model ?? this.defaultModelId;
    if (!resolvedModelId) {
      throw new Error(
        'openaiCompatible requires a routed model id. Create providers through the provider registry or provide defaultModelId.'
      );
    }
    const parsed = this.parseModelId(resolvedModelId);
    if ('code' in parsed) {
      throw new Error(parsed.detail);
    }
    const prompt = buildReviewInput(input);
    const renderedInputChars = prompt.length + input.rubric.length;

    const fallbackModels = parsed.policy.fallbackModelIds.slice(
      0,
      Math.max(0, parsed.policy.maxAttempts - 1)
    );
    const fallbacks = fallbackModels.map((fallbackModelId) => {
      const fallback = this.parseModelId(fallbackModelId);
      if ('code' in fallback) {
        throw new Error(
          `provider policy ${parsed.policy.policyVersion} references invalid fallback ${fallbackModelId}.`
        );
      }
      if (!retentionCompatible(parsed.policy, fallback.policy)) {
        throw new Error(
          `provider policy ${parsed.policy.policyVersion} fallback ${fallback.routedModelId} weakens retention constraints.`
        );
      }
      return fallback;
    });
    const attempts = [parsed, ...fallbacks];
    const providerAttempts: ProviderAttemptTelemetry[] = [];
    let lastFailureClass: ProviderFailureClass = 'unknown';

    for (const attempt of attempts) {
      if (renderedInputChars > attempt.policy.maxInputChars) {
        lastFailureClass = 'budget';
        providerAttempts.push({
          route: attempt.route.id,
          model: attempt.routedModelId,
          status: 'failed',
          latencyMs: 0,
          failureClass: 'budget',
          errorCode: 'input_budget_exceeded',
          retryable: false,
        });
        continue;
      }
      const provider = this.factories.get(attempt.route.id);
      if (!provider || !attempt.route.apiKey) {
        const failureClass: ProviderFailureClass = attempt.route.apiKey
          ? 'policy'
          : 'auth';
        lastFailureClass = failureClass;
        providerAttempts.push({
          route: attempt.route.id,
          model: attempt.routedModelId,
          status: 'skipped',
          latencyMs: 0,
          failureClass,
          errorCode: attempt.route.apiKey
            ? 'route_not_configured'
            : 'auth_missing',
          retryable: false,
        });
        continue;
      }

      const startedAt = performance.now();
      try {
        const providerOptions = buildGatewayProviderOptions(
          attempt.route,
          attempt.policy
        );
        const result = await generateText({
          model: provider(attempt.modelId),
          system: input.rubric,
          prompt,
          maxOutputTokens: attempt.policy.maxOutputTokens,
          timeout: {
            totalMs: attempt.policy.timeoutMs,
            stepMs: attempt.policy.timeoutMs,
          },
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          ...(providerOptions
            ? {
                providerOptions: providerOptions as Parameters<
                  typeof generateText
                >[0]['providerOptions'] & {},
              }
            : {}),
          output: Output.object({
            schema: RawModelOutputSchema,
            name: 'code_review_output',
            description: 'Structured review findings and correctness verdict',
          }),
        });
        const usage = extractProviderUsage(result);
        const finalProvider = extractFinalProvider(result.providerMetadata);
        const generationId = extractGenerationId(result.providerMetadata);
        const latencyMs = attemptLatencyMs(startedAt);
        providerAttempts.push({
          route: attempt.route.id,
          model: attempt.routedModelId,
          status: 'success',
          latencyMs,
          failureClass: 'none',
          usage,
          ...(finalProvider ? { provider: finalProvider } : {}),
          ...(generationId ? { generationId } : {}),
        });
        const telemetry: ProviderPolicyTelemetry = {
          policyVersion: parsed.policy.policyVersion,
          requestedModel: resolvedModelId,
          resolvedModel: attempt.routedModelId,
          route: attempt.route.id,
          ...(finalProvider ? { finalProvider } : {}),
          fallbackOrder: fallbackModels,
          fallbackUsed: attempt.routedModelId !== parsed.routedModelId,
          maxInputChars: attempt.policy.maxInputChars,
          maxOutputTokens: attempt.policy.maxOutputTokens,
          timeoutMs: attempt.policy.timeoutMs,
          maxAttempts: parsed.policy.maxAttempts,
          retention: attempt.policy.retention,
          zdrRequired: attempt.policy.zdrRequired,
          disallowPromptTraining: attempt.policy.disallowPromptTraining,
          failureClass: 'none',
          totalLatencyMs: providerAttempts.reduce(
            (
              total: number,
              item: ProviderPolicyTelemetry['attempts'][number]
            ) => total + item.latencyMs,
            0
          ),
          attempts: providerAttempts,
          usage,
        };

        return {
          raw: result.output,
          text: JSON.stringify(result.output),
          resolvedModel: attempt.routedModelId,
          providerTelemetry: telemetry,
        };
      } catch (error) {
        const failureClass = classifyProviderError(error);
        const retryable = retryableFor(error);
        lastFailureClass = failureClass;
        providerAttempts.push({
          route: attempt.route.id,
          model: attempt.routedModelId,
          status: 'failed',
          latencyMs: attemptLatencyMs(startedAt),
          failureClass,
          errorCode: safeErrorCode(error),
          ...(retryable === undefined ? {} : { retryable }),
        });
        if (failureClass === 'cancelled') {
          throw error;
        }
      }
    }

    throw new ProviderFallbackError(
      `openaiCompatible provider failed with failure class ${lastFailureClass}; no policy fallback succeeded.`,
      { providerAttempts, lastFailureClass }
    );
  }
}

/**
 * Creates the OpenAI-compatible review provider from a route and policy registry.
 *
 * @param options - Route factories, policy catalog, capabilities, and optional default model.
 * @returns A review provider that enforces the configured model policies.
 */
export function createOpenAICompatibleReviewProvider(
  options: OpenAICompatibleProviderOptions
): ReviewProvider {
  return new OpenAICompatibleReviewProvider(options);
}
