import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { ConvexMetadataBridge } from '@review-agent/review-convex-bridge';
import { createReviewProviders } from '@review-agent/review-provider-registry';
import { ReviewWorker } from '@review-agent/review-worker';
import { createReviewServiceApp, type ReviewServiceAuthMode } from './app.js';
import {
  createGitHubAppInstallationTokenProvider,
  createGitHubUserTokenAuthorizer,
  createReviewServiceAuthPolicy,
} from './auth.js';
import { createGitHubPublicationService } from './github-publication.js';
import {
  createReviewAuthStoreFromEnv,
  createReviewFindingTriageStoreFromEnv,
  createReviewPublicationStoreFromEnv,
  createReviewStoreFromEnv,
  type ReviewAuthStoreAdapter,
  type ReviewFindingTriageStoreAdapter,
  type ReviewPublicationStoreAdapter,
} from './storage/index.js';

function parseListEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : fallback;
}

function normalizePrivateKey(value: string): string {
  return value.replaceAll('\\n', '\n');
}

function createAuthDependencies(): {
  authMode: ReviewServiceAuthMode;
  authStore?: ReviewAuthStoreAdapter;
  authPolicy?: ReturnType<typeof createReviewServiceAuthPolicy>;
} {
  const authMode = process.env.REVIEW_SERVICE_AUTH_MODE ?? 'required';
  if (authMode === 'disabled') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'REVIEW_SERVICE_AUTH_MODE=disabled is not allowed in production'
      );
    }
    return { authMode: 'disabled' };
  }
  if (authMode !== 'required') {
    throw new Error(
      'REVIEW_SERVICE_AUTH_MODE must be "required" or "disabled"'
    );
  }

  const serviceTokenPepper = process.env.REVIEW_SERVICE_TOKEN_PEPPER;
  if (!serviceTokenPepper) {
    throw new Error(
      'REVIEW_SERVICE_TOKEN_PEPPER is required when review-service auth is enabled'
    );
  }

  const authStore = createReviewAuthStoreFromEnv(process.env, {
    allowInMemoryFallback: process.env.NODE_ENV !== 'production',
  });
  return {
    authMode: 'required',
    authStore,
    authPolicy: createReviewServiceAuthPolicy({
      store: authStore,
      serviceTokenPepper,
      githubUserTokenAuthorizer: createGitHubUserTokenAuthorizer(
        process.env.GITHUB_API_BASE_URL
          ? { baseUrl: process.env.GITHUB_API_BASE_URL }
          : {}
      ),
    }),
  };
}

function createPublicationDependencies(): {
  publicationStore: ReviewPublicationStoreAdapter;
  findingTriageStore: ReviewFindingTriageStoreAdapter;
  publicationService?: ReturnType<typeof createGitHubPublicationService>;
} {
  const publicationStore = createReviewPublicationStoreFromEnv(process.env, {
    allowInMemoryFallback: process.env.NODE_ENV !== 'production',
  });
  const findingTriageStore = createReviewFindingTriageStoreFromEnv(
    process.env,
    {
      allowInMemoryFallback: process.env.NODE_ENV !== 'production',
    }
  );
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    return { findingTriageStore, publicationStore };
  }
  return {
    findingTriageStore,
    publicationStore,
    publicationService: createGitHubPublicationService({
      publicationStore,
      installationTokenProvider: createGitHubAppInstallationTokenProvider({
        appId,
        privateKey: normalizePrivateKey(privateKey),
      }),
      ...(process.env.GITHUB_API_BASE_URL
        ? { baseUrl: process.env.GITHUB_API_BASE_URL }
        : {}),
    }),
  };
}

const authDependencies = createAuthDependencies();
const publicationDependencies = createPublicationDependencies();
const allowedCwdRoots = parseListEnv('REVIEW_SERVICE_ALLOWED_CWD_ROOTS', [
  process.cwd(),
]);

const app = createReviewServiceApp({
  providers: createReviewProviders(),
  worker: new ReviewWorker(),
  bridge: new ConvexMetadataBridge(),
  store: createReviewStoreFromEnv(),
  ...authDependencies,
  ...publicationDependencies,
  uuid: randomUUID,
  config: {
    allowedCwdRoots,
    hostedRepositoryRoots: parseListEnv(
      'REVIEW_SERVICE_HOSTED_REPOSITORY_ROOTS',
      allowedCwdRoots
    ),
  },
});

const port = Number.parseInt(process.env.PORT ?? '3042', 10);
console.error(`review-service listening on :${port}`);
serve({
  fetch: app.fetch,
  port,
});
