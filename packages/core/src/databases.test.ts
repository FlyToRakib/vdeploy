import { DatabaseEngine } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import {
  connectionUrl,
  connectionWarning,
  databaseHost,
  databaseImage,
  databaseNames,
  defaultEnvKey,
  defaultLinkParts,
  defaultVersion,
  ENGINES,
  isMajorUpgrade,
  linkSettings,
} from './databases.js';

describe('managed databases', () => {
  it('knows every engine it offers, with a version and a place for its files', () => {
    for (const engine of DatabaseEngine.options) {
      const profile = ENGINES[engine];
      expect(profile.versions.length).toBeGreaterThan(0);
      expect(profile.dataPath.startsWith('/')).toBe(true);
      expect(profile.port).toBeGreaterThan(0);
      expect(databaseImage(engine, defaultVersion(engine))).toContain(profile.repository);
    }
  });

  it('writes a connection string a library can use, whatever the password contains', () => {
    const url = connectionUrl({
      engine: 'postgres',
      host: 'vd-db-abc',
      port: 5432,
      user: 'vdeploy',
      password: 'p@ss/word #1',
      dbName: 'blog',
    });
    expect(url).toBe('postgres://vdeploy:p%40ss%2Fword%20%231@vd-db-abc:5432/blog');
    expect(new URL(url).password).toBe(encodeURIComponent('p@ss/word #1'));
  });

  it('writes Redis with no user and no database', () => {
    const url = connectionUrl({
      engine: 'redis',
      host: 'vd-db-xyz',
      port: 6379,
      user: 'default',
      password: 'secret',
      dbName: null,
    });
    expect(url).toBe('redis://:secret@vd-db-xyz:6379');
    expect(defaultEnvKey('redis')).toBe('REDIS_URL');
    expect(defaultEnvKey('postgres')).toBe('DATABASE_URL');
  });

  it('never lets a name become something else inside the engine', () => {
    expect(databaseNames('postgres', 'My Blog-DB')).toEqual({
      user: 'vdeploy',
      dbName: 'my_blog_db',
    });
    expect(databaseNames('redis', 'cache').dbName).toBeNull();
    expect(databaseHost('db_01M38MNZ234BJ3SRF46177CA7J')).toBe('vd-db-01m38mnz234bj3srf46177ca7j');
  });

  it('calls a major-version jump what it is', () => {
    expect(isMajorUpgrade('16', '17')).toBe(true);
    expect(isMajorUpgrade('8.0', '8.4')).toBe(false);
    expect(isMajorUpgrade('8.4', '9')).toBe(true);
  });

  it('warns before the app opens more connections than the database allows', () => {
    expect(connectionWarning({ engine: 'postgres', replicas: 2, poolSize: 10 })).toBeNull();
    const warning = connectionWarning({ engine: 'postgres', replicas: 8, poolSize: 20 });
    expect(warning).toContain('160');
    expect(warning).toContain('about 100');
    expect(connectionWarning({ engine: 'redis', replicas: 8, poolSize: 20 })).toBeNull();
  });

  it('hands an app object storage the way the S3 SDKs read it', () => {
    const endpoint = connectionUrl({
      engine: 's3',
      host: 'vd-db-abc',
      port: 9000,
      user: 'vdeploy',
      password: 'never-in-the-url',
      dbName: 'uploads',
    });
    expect(endpoint).toBe('http://vd-db-abc:9000');
    expect(defaultEnvKey('s3')).toBe('AWS_ENDPOINT_URL');
    expect(defaultLinkParts('s3')).toEqual({
      user: 'AWS_ACCESS_KEY_ID',
      password: 'AWS_SECRET_ACCESS_KEY',
      name: 'S3_BUCKET',
    });
    expect(linkSettings('s3')).toEqual([{ key: 'AWS_REGION', value: 'us-east-1' }]);
    expect(defaultLinkParts('postgres')).toEqual({});
    expect(linkSettings('postgres')).toEqual([]);
    expect(connectionWarning({ engine: 's3', replicas: 50, poolSize: 50 })).toBeNull();
  });

  it('names a bucket the way S3 allows', () => {
    expect(databaseNames('s3', 'Shop_Uploads!').dbName).toBe('shop-uploads');
    expect(databaseNames('s3', 'x').dbName).toBe('x-bucket');
    expect(databaseNames('s3', '__').dbName).toBe('files-bucket');
    const long = databaseNames('s3', 'a'.repeat(62) + '-b').dbName ?? '';
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
  });
});
