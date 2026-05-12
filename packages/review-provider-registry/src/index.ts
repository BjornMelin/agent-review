import {
  type CodexProviderOptions,
  createCodexDelegateProvider,
} from '@review-agent/review-provider-codex';
import {
  createOpenAICompatibleReviewProvider,
  type OpenAICompatibleModelPolicy,
  type OpenAICompatibleRouteConfig,
} from '@review-agent/review-provider-openai';
import type {
  ProviderDiagnostic,
  ReviewProvider,
  ReviewProviderCapabilities,
  ReviewRequest,
} from '@review-agent/review-types';
import { redactErrorMessage } from '@review-agent/review-types';

/**
 * Names the CLI provider routes accepted by provider-facing commands.
 */
export type CliProviderRoute = 'codex' | 'gateway' | 'openrouter';

/**
 * Names provider filters accepted by doctor checks.
 */
export type DoctorProviderFilter = CliProviderRoute | 'all';

/**
 * Names OpenAI-compatible route families backed by the shared provider adapter.
 */
export type OpenAICompatibleRoute = 'gateway' | 'openrouter';

/**
 * Maps each review provider kind to the provider implementation used at runtime.
 */
export type ReviewProviderRegistry = Record<
  ReviewRequest['provider'],
  ReviewProvider
>;

/**
 * Configures all providers exposed by the review provider registry.
 */
export type ReviewProviderRegistryOptions = {
  codex?: CodexProviderOptions;
  openaiCompatible?: OpenAICompatibleRegistryOptions;
};

/**
 * Configures gateway and OpenRouter credentials plus endpoint overrides.
 */
export type OpenAICompatibleRegistryOptions = {
  defaultModelId?: string;
  gatewayApiKey?: string;
  gatewayBaseURL?: string;
  openRouterApiKey?: string;
  openRouterBaseURL?: string;
  openRouterHeaders?: Record<string, string>;
};

/**
 * Captures the normalized provider and model routed from CLI flags.
 */
export type ProviderModelSelection = {
  provider: ReviewRequest['provider'];
  model: string | undefined;
};

/**
 * Describes one sanitized provider doctor check result.
 */
export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
  remediation?: string;
};

/**
 * Describes one allowlisted provider model and its policy metadata.
 */
export type ModelEntry = {
  id: string;
  provider: OpenAICompatibleRoute;
  default: boolean;
  capabilities: ReviewProviderCapabilities;
  policy: {
    version: string;
    fallbackOrder: readonly string[];
    maxInputChars: number;
    maxOutputTokens: number;
    timeoutMs: number;
    maxAttempts: number;
    retention: OpenAICompatibleModelPolicy['retention'];
    zdrRequired: boolean;
    disallowPromptTraining: boolean;
  };
};

const PROVIDER_IDS = [
  'codexDelegate',
  'openaiCompatible',
] as const satisfies readonly ReviewRequest['provider'][];

const OPENAI_ROUTE_PREFIXES = ['gateway', 'openrouter'] as const;
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

const OPENAI_COMPATIBLE_CAPABILITIES: ReviewProviderCapabilities = {
  jsonSchemaOutput: true,
  reasoningControl: false,
  streaming: false,
};

/**
 * Versions the provider policy catalog emitted in telemetry and model listings.
 */
export const MODEL_POLICY_VERSION = 'provider-policy.v1';

const DEFAULT_MODEL_POLICY = {
  policyVersion: MODEL_POLICY_VERSION,
  maxInputChars: 120_000,
  maxOutputTokens: 4_096,
  timeoutMs: 120_000,
  maxAttempts: 3,
  retention: 'unknown',
  zdrRequired: false,
  disallowPromptTraining: true,
} as const;

/**
 * Maps each OpenAI-compatible route to its default allowlisted model.
 */
export const DEFAULT_MODEL_BY_ROUTE: Record<OpenAICompatibleRoute, string> = {
  gateway: 'gateway:openai/gpt-5',
  openrouter: 'openrouter:openai/gpt-5',
};

/**
 * Lists the allowlisted models and routing policy exposed to CLI and provider code.
 */
export const MODEL_CATALOG: readonly ModelEntry[] = [
  {
    provider: 'gateway',
    id: DEFAULT_MODEL_BY_ROUTE.gateway,
    default: true,
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    policy: {
      version: MODEL_POLICY_VERSION,
      fallbackOrder: [
        'gateway:anthropic/claude-sonnet-4-5',
        'gateway:google/gemini-3-flash',
      ],
      maxInputChars: DEFAULT_MODEL_POLICY.maxInputChars,
      maxOutputTokens: DEFAULT_MODEL_POLICY.maxOutputTokens,
      timeoutMs: DEFAULT_MODEL_POLICY.timeoutMs,
      maxAttempts: DEFAULT_MODEL_POLICY.maxAttempts,
      retention: DEFAULT_MODEL_POLICY.retention,
      zdrRequired: DEFAULT_MODEL_POLICY.zdrRequired,
      disallowPromptTraining: DEFAULT_MODEL_POLICY.disallowPromptTraining,
    },
  },
  {
    provider: 'gateway',
    id: 'gateway:anthropic/claude-sonnet-4-5',
    default: false,
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    policy: {
      version: MODEL_POLICY_VERSION,
      fallbackOrder: ['gateway:openai/gpt-5'],
      maxInputChars: DEFAULT_MODEL_POLICY.maxInputChars,
      maxOutputTokens: DEFAULT_MODEL_POLICY.maxOutputTokens,
      timeoutMs: DEFAULT_MODEL_POLICY.timeoutMs,
      maxAttempts: 2,
      retention: DEFAULT_MODEL_POLICY.retention,
      zdrRequired: DEFAULT_MODEL_POLICY.zdrRequired,
      disallowPromptTraining: DEFAULT_MODEL_POLICY.disallowPromptTraining,
    },
  },
  {
    provider: 'gateway',
    id: 'gateway:google/gemini-3-flash',
    default: false,
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    policy: {
      version: MODEL_POLICY_VERSION,
      fallbackOrder: ['gateway:openai/gpt-5'],
      maxInputChars: DEFAULT_MODEL_POLICY.maxInputChars,
      maxOutputTokens: DEFAULT_MODEL_POLICY.maxOutputTokens,
      timeoutMs: DEFAULT_MODEL_POLICY.timeoutMs,
      maxAttempts: 2,
      retention: DEFAULT_MODEL_POLICY.retention,
      zdrRequired: DEFAULT_MODEL_POLICY.zdrRequired,
      disallowPromptTraining: DEFAULT_MODEL_POLICY.disallowPromptTraining,
    },
  },
  {
    provider: 'openrouter',
    id: DEFAULT_MODEL_BY_ROUTE.openrouter,
    default: true,
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    policy: {
      version: MODEL_POLICY_VERSION,
      fallbackOrder: ['openrouter:anthropic/claude-sonnet-4.5'],
      maxInputChars: DEFAULT_MODEL_POLICY.maxInputChars,
      maxOutputTokens: DEFAULT_MODEL_POLICY.maxOutputTokens,
      timeoutMs: DEFAULT_MODEL_POLICY.timeoutMs,
      maxAttempts: 2,
      retention: 'providerRetained',
      zdrRequired: false,
      disallowPromptTraining: false,
    },
  },
  {
    provider: 'openrouter',
    id: 'openrouter:anthropic/claude-sonnet-4.5',
    default: false,
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    policy: {
      version: MODEL_POLICY_VERSION,
      fallbackOrder: ['openrouter:openai/gpt-5'],
      maxInputChars: DEFAULT_MODEL_POLICY.maxInputChars,
      maxOutputTokens: DEFAULT_MODEL_POLICY.maxOutputTokens,
      timeoutMs: DEFAULT_MODEL_POLICY.timeoutMs,
      maxAttempts: 2,
      retention: 'providerRetained',
      zdrRequired: false,
      disallowPromptTraining: false,
    },
  },
];

const MODEL_CATALOG_BY_ID = new Map(
  MODEL_CATALOG.map((entry) => [entry.id, entry])
);

function isOpenAICompatibleRoute(
  value: string
): value is OpenAICompatibleRoute {
  return OPENAI_ROUTE_PREFIXES.includes(value as OpenAICompatibleRoute);
}

function ensureCatalogModel(modelId: string): string {
  if (!MODEL_CATALOG_BY_ID.has(modelId)) {
    throw new Error(
      `model "${modelId}" is not in the provider policy catalog. Run review-agent models --json to list allowlisted models.`
    );
  }
  return modelId;
}

function providerSlugForModel(model: string): string {
  return model.split('/')[0] ?? model;
}

/**
 * Splits a routed OpenAI-compatible model ID into route and provider model parts.
 *
 * @param modelId - Model ID in `<route>:<provider-model>` form.
 * @returns The parsed route and provider model ID.
 */
export function parseOpenAICompatibleModelId(modelId: string): {
  route: OpenAICompatibleRoute;
  model: string;
} {
  const separator = modelId.indexOf(':');
  const providerModelId = modelId.slice(separator + 1).trim();
  if (separator < 1 || !providerModelId) {
    throw new Error(
      `invalid model id "${modelId}". Expected "gateway:<model>" or "openrouter:<model>".`
    );
  }

  const route = modelId.slice(0, separator);
  if (!isOpenAICompatibleRoute(route)) {
    throw new Error(
      `unsupported model route "${route}". Use "gateway" or "openrouter".`
    );
  }

  return {
    route,
    model: providerModelId,
  };
}

/**
 * Normalizes CLI model input into a catalog-checked routed model ID.
 *
 * @param route - OpenAI-compatible route selected by the caller.
 * @param model - Optional raw model value supplied by the user.
 * @returns A routed model ID that exists in the allowlist catalog.
 */
export function normalizeOpenAICompatibleModelId(
  route: OpenAICompatibleRoute,
  model: string | undefined
): string {
  const candidate = model?.trim();
  if (!candidate) {
    return DEFAULT_MODEL_BY_ROUTE[route];
  }

  const existingPrefix = candidate.slice(0, candidate.indexOf(':'));
  if (candidate.includes(':')) {
    if (!isOpenAICompatibleRoute(existingPrefix)) {
      throw new Error(
        `unsupported model route "${existingPrefix}". Use "gateway" or "openrouter".`
      );
    }
    if (existingPrefix !== route) {
      throw new Error(
        `--provider ${route} cannot use "${existingPrefix}:" model ids.`
      );
    }
    const parsed = parseOpenAICompatibleModelId(candidate);
    return ensureCatalogModel(`${parsed.route}:${parsed.model}`);
  }

  return ensureCatalogModel(`${route}:${candidate}`);
}

function buildModelPolicies(): OpenAICompatibleModelPolicy[] {
  return MODEL_CATALOG.map((entry) => {
    const parsed = parseOpenAICompatibleModelId(entry.id);
    const gatewayProviderSlug = providerSlugForModel(parsed.model);
    const policy: OpenAICompatibleModelPolicy = {
      id: entry.id,
      route: parsed.route,
      policyVersion: entry.policy.version,
      fallbackModelIds: entry.policy.fallbackOrder,
      maxInputChars: entry.policy.maxInputChars,
      maxOutputTokens: entry.policy.maxOutputTokens,
      timeoutMs: entry.policy.timeoutMs,
      maxAttempts: entry.policy.maxAttempts,
      retention: entry.policy.retention,
      zdrRequired: entry.policy.zdrRequired,
      disallowPromptTraining: entry.policy.disallowPromptTraining,
      ...(parsed.route === 'gateway'
        ? {
            gateway: {
              only: [gatewayProviderSlug],
              order: [gatewayProviderSlug],
              providerTimeouts: {
                byok: {
                  [gatewayProviderSlug]: entry.policy.timeoutMs,
                },
              },
            },
          }
        : {}),
    };
    return policy;
  });
}

function buildOpenAICompatibleRoutes(
  options: OpenAICompatibleRegistryOptions = {}
): OpenAICompatibleRouteConfig[] {
  const gatewayRoute: OpenAICompatibleRouteConfig = {
    id: 'gateway',
    kind: 'gateway',
    displayName: 'AI Gateway',
    apiKeyEnv: 'AI_GATEWAY_API_KEY',
    ...(options.gatewayApiKey !== undefined
      ? { apiKey: options.gatewayApiKey }
      : {}),
    ...(options.gatewayBaseURL !== undefined
      ? { baseURL: options.gatewayBaseURL }
      : {}),
  };
  const openRouterRoute: OpenAICompatibleRouteConfig = {
    id: 'openrouter',
    kind: 'openaiCompatibleChat',
    displayName: 'OpenRouter',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseURL: options.openRouterBaseURL ?? DEFAULT_OPENROUTER_BASE_URL,
    ...(options.openRouterApiKey !== undefined
      ? { apiKey: options.openRouterApiKey }
      : {}),
    ...(options.openRouterHeaders !== undefined
      ? { headers: options.openRouterHeaders }
      : {}),
  };

  return [gatewayRoute, openRouterRoute];
}

/**
 * Resolves CLI provider flags into the canonical runtime provider and model selection.
 *
 * @param provider - CLI provider route requested by the user.
 * @param model - Optional model override supplied by the user.
 * @returns The runtime provider kind and normalized model selection.
 */
export function normalizeCliProviderModel(
  provider: CliProviderRoute,
  model: string | undefined
): ProviderModelSelection {
  switch (provider) {
    case 'codex':
      return {
        provider: 'codexDelegate',
        model: model?.trim() || undefined,
      };
    case 'gateway':
    case 'openrouter':
      return {
        provider: 'openaiCompatible',
        model: normalizeOpenAICompatibleModelId(provider, model),
      };
    default:
      throw new Error(
        `invalid provider "${String(provider)}"; expected codex|gateway|openrouter`
      );
  }
}

/**
 * Creates the complete review provider registry used by CLI and service execution.
 *
 * @param options - Optional provider-specific configuration and credentials.
 * @returns Runtime provider implementations keyed by review provider kind.
 */
export function createReviewProviders(
  options: ReviewProviderRegistryOptions = {}
): ReviewProviderRegistry {
  return {
    codexDelegate: createCodexDelegateProvider(options.codex),
    openaiCompatible: createOpenAICompatibleReviewProvider({
      defaultModelId:
        options.openaiCompatible?.defaultModelId ??
        DEFAULT_MODEL_BY_ROUTE.gateway,
      capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
      modelPolicies: buildModelPolicies(),
      routes: buildOpenAICompatibleRoutes(options.openaiCompatible),
    }),
  };
}

/**
 * Returns a defensive copy of the allowlisted provider model catalog.
 *
 * @returns Model catalog entries with cloned nested policy metadata.
 */
export function listModelCatalog(): ModelEntry[] {
  return MODEL_CATALOG.map((model) => ({
    ...model,
    capabilities: { ...model.capabilities },
    policy: {
      ...model.policy,
      fallbackOrder: [...model.policy.fallbackOrder],
    },
  }));
}

/**
 * Runs non-secret provider availability and configuration diagnostics.
 *
 * @param providers - Provider registry to inspect, defaulting to the configured runtime registry.
 * @returns Sanitized doctor checks for provider availability and route diagnostics.
 */
export async function runProviderDoctorChecks(
  providers: Partial<ReviewProviderRegistry> = createReviewProviders()
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  for (const providerId of PROVIDER_IDS) {
    const provider = providers[providerId];
    if (!provider) {
      checks.push({
        name: `provider.${providerId}.available`,
        ok: false,
        detail: `${providerId} provider is missing`,
        remediation: `Ensure ${providerId} is registered before running doctor checks.`,
      });
      continue;
    }

    checks.push({
      name: `provider.${providerId}.available`,
      ok: true,
      detail: `${providerId} provider is configured`,
    });

    let diagnostics: ProviderDiagnostic[] = [];
    try {
      diagnostics = (await provider.doctor?.()) ?? [];
    } catch (error) {
      checks.push({
        name: `provider.${providerId}.doctor`,
        ok: false,
        detail: redactErrorMessage(error, 'doctor check failed'),
      });
      continue;
    }

    for (const diagnostic of diagnostics) {
      const check: DoctorCheck = {
        name: diagnostic.scope
          ? `provider.${providerId}.${diagnostic.scope}.${diagnostic.code}`
          : `provider.${providerId}.${diagnostic.code}`,
        ok: diagnostic.ok,
        detail: diagnostic.detail,
      };
      if (diagnostic.remediation) {
        check.remediation = diagnostic.remediation;
      }
      checks.push(check);
    }
  }

  return checks;
}

/**
 * Filters provider doctor checks to the selected CLI provider surface.
 *
 * @param checks - Doctor checks returned by provider diagnostics.
 * @param provider - Provider filter requested by the user.
 * @returns Checks matching the selected provider route.
 */
export function filterDoctorChecks(
  checks: DoctorCheck[],
  provider: DoctorProviderFilter
): DoctorCheck[] {
  if (provider === 'all') {
    return checks;
  }
  if (
    provider !== 'codex' &&
    provider !== 'gateway' &&
    provider !== 'openrouter'
  ) {
    throw new Error(`invalid provider filter "${String(provider)}"`);
  }

  const providerPrefix =
    provider === 'codex'
      ? 'provider.codexDelegate.'
      : 'provider.openaiCompatible.';
  const providerChecks = checks.filter((check) =>
    check.name.startsWith(providerPrefix)
  );
  if (provider === 'codex') {
    return providerChecks;
  }

  const routePrefix = `provider.openaiCompatible.${provider}.`;
  return providerChecks.filter((check) => {
    if (check.name.endsWith('.available')) {
      return true;
    }
    return check.name.startsWith(routePrefix);
  });
}
