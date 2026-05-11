import {
  type CodexProviderOptions,
  createCodexDelegateProvider,
} from '@review-agent/review-provider-codex';
import {
  createOpenAICompatibleReviewProvider,
  type OpenAICompatibleRouteConfig,
} from '@review-agent/review-provider-openai';
import type {
  ProviderDiagnostic,
  ReviewProvider,
  ReviewProviderCapabilities,
  ReviewRequest,
} from '@review-agent/review-types';

export type CliProviderRoute = 'codex' | 'gateway' | 'openrouter';
export type DoctorProviderFilter = CliProviderRoute | 'all';
export type OpenAICompatibleRoute = 'gateway' | 'openrouter';
export type ReviewProviderRegistry = Record<
  ReviewRequest['provider'],
  ReviewProvider
>;

export type ReviewProviderRegistryOptions = {
  codex?: CodexProviderOptions;
  openaiCompatible?: OpenAICompatibleRegistryOptions;
};

export type OpenAICompatibleRegistryOptions = {
  defaultModelId?: string;
  gatewayApiKey?: string;
  gatewayBaseURL?: string;
  openRouterApiKey?: string;
  openRouterBaseURL?: string;
  openRouterHeaders?: Record<string, string>;
};

export type ProviderModelSelection = {
  provider: ReviewRequest['provider'];
  model: string | undefined;
};

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
  remediation?: string;
};

export type ModelEntry = {
  id: string;
  provider: OpenAICompatibleRoute;
  default: boolean;
  capabilities: ReviewProviderCapabilities;
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

export const DEFAULT_MODEL_BY_ROUTE: Record<OpenAICompatibleRoute, string> = {
  gateway: 'gateway:openai/gpt-5',
  openrouter: 'openrouter:openai/gpt-5',
};

export const MODEL_CATALOG: readonly ModelEntry[] = [
  {
    provider: 'gateway',
    id: DEFAULT_MODEL_BY_ROUTE.gateway,
    default: true,
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
  },
  {
    provider: 'gateway',
    id: 'gateway:anthropic/claude-sonnet-4-5',
    default: false,
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
  },
  {
    provider: 'gateway',
    id: 'gateway:google/gemini-3-flash',
    default: false,
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
  },
  {
    provider: 'openrouter',
    id: DEFAULT_MODEL_BY_ROUTE.openrouter,
    default: true,
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
  },
  {
    provider: 'openrouter',
    id: 'openrouter:anthropic/claude-sonnet-4.5',
    default: false,
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
  },
];

function isOpenAICompatibleRoute(
  value: string
): value is OpenAICompatibleRoute {
  return OPENAI_ROUTE_PREFIXES.includes(value as OpenAICompatibleRoute);
}

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
    return `${parsed.route}:${parsed.model}`;
  }

  return `${route}:${candidate}`;
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
      routes: buildOpenAICompatibleRoutes(options.openaiCompatible),
    }),
  };
}

export function listModelCatalog(): ModelEntry[] {
  return MODEL_CATALOG.map((model) => ({
    ...model,
    capabilities: { ...model.capabilities },
  }));
}

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
        detail: error instanceof Error ? error.message : String(error),
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
