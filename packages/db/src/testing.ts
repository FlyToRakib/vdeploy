import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { connect, migrateToLatest, type DatabaseHandle } from './client.js';

export interface TestDatabase extends DatabaseHandle {
  url: string;
  stop: () => Promise<void>;
}

/** A real, migrated Postgres 16 in a throwaway container. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:16-alpine',
  ).start();
  const url = container.getConnectionUri();
  const handle = connect(url, { max: 4 });
  await migrateToLatest(handle.db);
  return {
    ...handle,
    url,
    stop: async () => {
      await handle.close();
      await container.stop();
    },
  };
}
