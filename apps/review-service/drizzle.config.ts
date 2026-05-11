import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;

/**
 * Configures Drizzle Kit to generate and apply review-service storage migrations.
 */
export default defineConfig({
  schema: './src/storage/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  strict: true,
  verbose: true,
  ...(databaseUrl
    ? {
        dbCredentials: {
          url: databaseUrl,
        },
      }
    : {}),
});
