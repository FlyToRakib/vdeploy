/** A managed database, as `database.list` returns it. */
export interface DatabaseSummary {
  id: string;
  serverId: string;
  name: string;
  engine: DatabaseEngine;
  version: string;
  image: string;
  status: 'creating' | 'running' | 'stopped' | 'failed' | 'deleting';
  host: string;
  port: number;
  user: string;
  dbName: string | null;
  memoryLimit: string;
  diskSize: string;
  links: { projectId: string; envKey: string }[];
  createdAt: string;
}

export type DatabaseEngine = 'postgres' | 'mysql' | 'mariadb' | 'redis' | 'mongodb';

/** What each engine is called, and what a person uses it for. */
export const ENGINE_WORDS: Readonly<Record<DatabaseEngine, { label: string; blurb: string }>> = {
  postgres: { label: 'PostgreSQL', blurb: 'The usual choice for a web app’s data.' },
  mysql: { label: 'MySQL', blurb: 'What WordPress and many older apps expect.' },
  mariadb: { label: 'MariaDB', blurb: 'MySQL’s twin; lighter on a small server.' },
  redis: { label: 'Redis', blurb: 'Fast temporary storage: sessions, queues, caching.' },
  mongodb: { label: 'MongoDB', blurb: 'Documents rather than tables.' },
};

/** Versions offered per engine, newest first; the first is the default. */
export const ENGINE_VERSIONS: Readonly<Record<DatabaseEngine, readonly string[]>> = {
  postgres: ['18', '17', '16', '15'],
  mysql: ['9', '8.4', '8.0'],
  mariadb: ['12', '11.8', '10.11'],
  redis: ['8', '7.4'],
  mongodb: ['8', '7'],
};

export const ENGINES = Object.keys(ENGINE_WORDS) as DatabaseEngine[];

/** What a status means to someone who is not watching containers. */
export function statusWords(status: DatabaseSummary['status']): {
  health: 'healthy' | 'warning' | 'failed' | 'neutral';
  words: string;
} {
  switch (status) {
    case 'running':
      return { health: 'healthy', words: 'Running' };
    case 'creating':
      return { health: 'warning', words: 'Starting up' };
    case 'stopped':
      return { health: 'neutral', words: 'Stopped' };
    case 'deleting':
      return { health: 'neutral', words: 'Being deleted' };
    default:
      return { health: 'failed', words: 'Needs a look' };
  }
}

/** The one line that tells a person where their data actually is. */
export function reachWords(database: DatabaseSummary): string {
  if (database.links.length === 0) {
    return 'Nothing can reach it yet. Link an app to give it the address.';
  }
  const apps = database.links.length === 1 ? 'one app' : `${String(database.links.length)} apps`;
  return `Reachable by ${apps}, and by nothing else — not even from the internet.`;
}

/** The variable an app will read, per engine. */
export function defaultEnvKey(engine: DatabaseEngine): string {
  return engine === 'redis' ? 'REDIS_URL' : 'DATABASE_URL';
}
