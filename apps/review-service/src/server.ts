import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { ConvexMetadataBridge } from '@review-agent/review-convex-bridge';
import { createReviewProviders } from '@review-agent/review-provider-registry';
import { ReviewWorker } from '@review-agent/review-worker';
import { createReviewServiceApp } from './app.js';
import { createReviewStoreFromEnv } from './storage/index.js';

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

const app = createReviewServiceApp({
  providers: createReviewProviders(),
  worker: new ReviewWorker(),
  bridge: new ConvexMetadataBridge(),
  store: createReviewStoreFromEnv(),
  uuid: randomUUID,
  config: {
    allowedCwdRoots: parseListEnv('REVIEW_SERVICE_ALLOWED_CWD_ROOTS', [
      process.cwd(),
    ]),
  },
});

const port = Number.parseInt(process.env.PORT ?? '3042', 10);
console.error(`review-service listening on :${port}`);
serve({
  fetch: app.fetch,
  port,
});
