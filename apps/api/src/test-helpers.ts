import { startTestDatabase, type TestDatabase } from '@vdeploy/db/testing';
import type { FastifyInstance } from 'fastify';
import { ApiConfig } from './config.js';
import { buildServer } from './server.js';

export const TEST_CONFIG = ApiConfig.parse({
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgres://unused/db',
  PUBLIC_URL: 'https://dashboard.example.com',
  APPROVAL_KEY: 'ab'.repeat(32),
});

export interface TestApp {
  app: FastifyInstance;
  database: TestDatabase;
  stop: () => Promise<void>;
}

export async function startTestApp(): Promise<TestApp> {
  const database = await startTestDatabase();
  const app = await buildServer({ config: TEST_CONFIG, db: database.db });
  return {
    app,
    database,
    stop: async () => {
      await app.close();
      await database.stop();
    },
  };
}
