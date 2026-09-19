import { defineConfig } from 'drizzle-kit';

// eslint-disable-next-line no-restricted-syntax -- drizzle-kit requires a default export
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
});
