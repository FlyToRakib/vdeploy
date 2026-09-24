import { describe, expect, it } from 'vitest';
import {
  defaultEnvKey,
  ENGINE_VERSIONS,
  ENGINE_WORDS,
  ENGINES,
  reachWords,
  statusWords,
  type DatabaseSummary,
} from './databases';

const database: DatabaseSummary = {
  id: 'db_1',
  serverId: 'srv_1',
  name: 'blog-db',
  engine: 'postgres',
  version: '18',
  image: 'postgres:18',
  status: 'running',
  host: 'vd-db-1',
  port: 5432,
  user: 'vdeploy',
  dbName: 'blog_db',
  memoryLimit: '512Mi',
  diskSize: '10Gi',
  links: [],
  createdAt: '2026-09-24T00:00:00.000Z',
};

describe('databases, in words', () => {
  it('names every engine it offers and what it is for', () => {
    for (const engine of ENGINES) {
      expect(ENGINE_WORDS[engine].label).toBeTruthy();
      expect(ENGINE_WORDS[engine].blurb).toMatch(/\.$/);
      expect(ENGINE_VERSIONS[engine].length).toBeGreaterThan(0);
    }
  });

  it('says what a status means without naming a container', () => {
    expect(statusWords('running')).toEqual({ health: 'healthy', words: 'Running' });
    expect(statusWords('creating')).toEqual({ health: 'warning', words: 'Starting up' });
    expect(statusWords('failed')).toEqual({ health: 'failed', words: 'Needs a look' });
  });

  it('is clear about who can reach the data', () => {
    expect(reachWords(database)).toContain('Nothing can reach it yet');
    expect(
      reachWords({ ...database, links: [{ projectId: 'prj_1', envKey: 'DATABASE_URL' }] }),
    ).toBe('Reachable by one app, and by nothing else — not even from the internet.');
    expect(
      reachWords({
        ...database,
        links: [
          { projectId: 'prj_1', envKey: 'DATABASE_URL' },
          { projectId: 'prj_2', envKey: 'DATABASE_URL' },
        ],
      }),
    ).toContain('2 apps');
  });

  it('gives each engine the variable its libraries look for', () => {
    expect(defaultEnvKey('redis')).toBe('REDIS_URL');
    expect(defaultEnvKey('mysql')).toBe('DATABASE_URL');
  });
});
