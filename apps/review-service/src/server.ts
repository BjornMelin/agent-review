import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { ConvexMetadataBridge } from '@review-agent/review-convex-bridge';
import { createReviewProviders } from '@review-agent/review-provider-registry';
import { ReviewWorker } from '@review-agent/review-worker';
import { createReviewServiceApp } from './app.js';
import { createReviewStoreFromEnv } from './storage/index.js';

const app = createReviewServiceApp({
  providers: createReviewProviders(),
  worker: new ReviewWorker(),
  bridge: new ConvexMetadataBridge(),
  store: createReviewStoreFromEnv(),
  uuid: randomUUID,
});

const port = Number.parseInt(process.env.PORT ?? '3042', 10);
console.error(`review-service listening on :${port}`);
serve({
  fetch: app.fetch,
  port,
});
