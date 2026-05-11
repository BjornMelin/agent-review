import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;

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
