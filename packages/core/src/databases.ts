import { OBJECT_STORAGE_ENV, VDeployError, type DatabaseEngine } from '@vdeploy/contracts';

/**
 * What each engine needs to run and to be reached (§17.3). Everything here
 * is decided once, in one place: the image, where its files live, the port
 * it answers on, the variables it reads at first start, and how a connection
 * string for it is written — so nobody ever assembles one by hand.
 */
export interface EngineProfile {
  /** The image repository; the version is the tag. */
  repository: string;
  /** Other images a compose file may name for the same thing. */
  alsoFrom?: readonly string[];
  /** Versions offered in the dashboard, newest first. The first is the default. */
  versions: readonly string[];
  port: number;
  dataPath: string;
  /** The account the app connects as. */
  user: string;
  /** The URL scheme an app's library expects. */
  scheme: string;
  /** A logical database inside the engine; Redis has none. */
  hasDbName: boolean;
  /** Smallest sensible memory limit for this engine on a small VPS. */
  memoryLimit: string;
  /** What the engine is told at first start; the password arrives sealed. */
  env: (input: { dbName: string | null; user: string }) => { key: string; value: string }[];
  /** The variable the sealed password is given as. */
  passwordKey: string;
}

export const ENGINES: Readonly<Record<DatabaseEngine, EngineProfile>> = {
  postgres: {
    repository: 'postgres',
    versions: ['18', '17', '16', '15'],
    port: 5432,
    dataPath: '/var/lib/postgresql/data',
    user: 'vdeploy',
    scheme: 'postgres',
    hasDbName: true,
    memoryLimit: '512Mi',
    env: ({ dbName, user }) => [
      { key: 'POSTGRES_USER', value: user },
      { key: 'POSTGRES_DB', value: dbName ?? user },
      // Postgres writes its cluster into a subfolder, so the volume can hold its own lost+found.
      { key: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
    ],
    passwordKey: 'POSTGRES_PASSWORD',
  },
  mysql: {
    repository: 'mysql',
    versions: ['9', '8.4', '8.0'],
    port: 3306,
    dataPath: '/var/lib/mysql',
    user: 'vdeploy',
    scheme: 'mysql',
    hasDbName: true,
    memoryLimit: '768Mi',
    env: ({ dbName, user }) => [
      { key: 'MYSQL_USER', value: user },
      { key: 'MYSQL_DATABASE', value: dbName ?? user },
    ],
    passwordKey: 'MYSQL_ROOT_PASSWORD',
  },
  mariadb: {
    repository: 'mariadb',
    versions: ['12', '11.8', '10.11'],
    port: 3306,
    dataPath: '/var/lib/mysql',
    user: 'vdeploy',
    scheme: 'mysql',
    hasDbName: true,
    memoryLimit: '512Mi',
    env: ({ dbName, user }) => [
      { key: 'MARIADB_USER', value: user },
      { key: 'MARIADB_DATABASE', value: dbName ?? user },
    ],
    passwordKey: 'MARIADB_ROOT_PASSWORD',
  },
  redis: {
    repository: 'redis',
    versions: ['8', '7.4'],
    port: 6379,
    dataPath: '/data',
    user: 'default',
    scheme: 'redis',
    hasDbName: false,
    memoryLimit: '256Mi',
    env: () => [],
    passwordKey: 'REDIS_PASSWORD',
  },
  mongodb: {
    repository: 'mongo',
    versions: ['8', '7'],
    port: 27017,
    dataPath: '/data/db',
    user: 'vdeploy',
    scheme: 'mongodb',
    hasDbName: true,
    memoryLimit: '768Mi',
    env: ({ user }) => [{ key: 'MONGO_INITDB_ROOT_USERNAME', value: user }],
    passwordKey: 'MONGO_INITDB_ROOT_PASSWORD',
  },
  /*
   * Object storage (§17.1, ADR 0026). MinIO's own images are no longer
   * published; RustFS is an S3 server of the same shape, Apache-2.0,
   * running as its own user. The bucket is the "database": the agent makes
   * it before the server starts, and the web console stays off.
   */
  s3: {
    repository: 'rustfs/rustfs',
    alsoFrom: ['minio/minio', 'quay.io/minio/minio', 'bitnami/minio'],
    versions: ['1.0.0'],
    port: 9000,
    dataPath: '/data',
    user: 'vdeploy',
    scheme: 'http',
    hasDbName: true,
    memoryLimit: '512Mi',
    env: ({ dbName, user }) => [
      { key: 'RUSTFS_ACCESS_KEY', value: user },
      { key: 'RUSTFS_CONSOLE_ENABLE', value: 'false' },
      { key: 'VDEPLOY_BUCKET', value: dbName ?? user },
    ],
    passwordKey: 'RUSTFS_SECRET_KEY',
  },
};

export function engineProfile(engine: DatabaseEngine): EngineProfile {
  return ENGINES[engine];
}

/** The version a person gets when they do not choose one. */
export function defaultVersion(engine: DatabaseEngine): string {
  const [latest] = ENGINES[engine].versions;
  if (!latest) throw new VDeployError('internal', `${engine} has no versions`);
  return latest;
}

/**
 * A major-version jump is never automatic (§17.3): the engine's files are
 * written in the old format and only its own tools can move them.
 */
export function isMajorUpgrade(from: string, to: string): boolean {
  return (from.split('.')[0] ?? '') !== (to.split('.')[0] ?? '');
}

/** The image, pinned to the exact version asked for. */
export function databaseImage(engine: DatabaseEngine, version: string): string {
  return `${ENGINES[engine].repository}:${version}`;
}

/** The name the engine answers to on the server's internal network. */
export function databaseHost(databaseId: string): string {
  return `vd-db-${databaseId.replace(/^db_/, '').toLowerCase()}`;
}

/** The logical database and account names, from what the person called it. */
export function databaseNames(
  engine: DatabaseEngine,
  name: string,
): { user: string; dbName: string | null } {
  const profile = ENGINES[engine];
  if (engine === 's3') return { user: profile.user, dbName: bucketName(name) };
  const safe = name.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  return { user: profile.user, dbName: profile.hasDbName ? safe : null };
}

/** A bucket name S3 accepts: 3 to 63 lowercase letters, digits and hyphens. */
function bucketName(name: string): string {
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return safe.length >= 3 ? safe : `${safe || 'files'}-bucket`;
}

export interface Connection {
  engine: DatabaseEngine;
  host: string;
  port: number;
  user: string;
  password: string;
  dbName: string | null;
}

/**
 * The connection string an app is given (§17.3): the person never assembles
 * one. Everything in it is percent-encoded, so a generated password with
 * any character in it cannot break the URL.
 */
export function connectionUrl(connection: Connection): string {
  const { scheme } = ENGINES[connection.engine];
  // An S3 endpoint carries no credentials: SDKs read the keys on their own.
  if (connection.engine === 's3') {
    return `${scheme}://${connection.host}:${String(connection.port)}`;
  }
  const credentials =
    connection.engine === 'redis'
      ? `:${encodeURIComponent(connection.password)}@`
      : `${encodeURIComponent(connection.user)}:${encodeURIComponent(connection.password)}@`;
  const path = connection.dbName ? `/${encodeURIComponent(connection.dbName)}` : '';
  return `${scheme}://${credentials}${connection.host}:${String(connection.port)}${path}`;
}

/**
 * The variable an app gets for a linked database. Libraries look for a
 * different name per engine, so the default follows the engine.
 */
export function defaultEnvKey(engine: DatabaseEngine): string {
  if (engine === 's3') return OBJECT_STORAGE_ENV.endpoint;
  return engine === 'redis' ? 'REDIS_URL' : 'DATABASE_URL';
}

export type LinkPart = 'host' | 'port' | 'user' | 'password' | 'name';

/**
 * The pieces a link hands an app unless it asks for others. Object storage
 * is never one URL: SDKs read the keys, the bucket and the region as
 * settings of their own.
 */
export function defaultLinkParts(engine: DatabaseEngine): Partial<Record<LinkPart, string>> {
  return engine === 's3'
    ? {
        user: OBJECT_STORAGE_ENV.accessKeyId,
        password: OBJECT_STORAGE_ENV.secretAccessKey,
        name: OBJECT_STORAGE_ENV.bucket,
      }
    : {};
}

/**
 * Fixed settings a link also hands over. A self-hosted S3 server has one
 * region, and the SDKs refuse to start without being told one.
 */
export function linkSettings(engine: DatabaseEngine): { key: string; value: string }[] {
  return engine === 's3' ? [{ key: OBJECT_STORAGE_ENV.region, value: 'us-east-1' }] : [];
}

/**
 * Replicas × pool size against the engine's connection limit (§17.3). A
 * warning, not a refusal: the person may know something we do not.
 */
export function connectionWarning(input: {
  engine: DatabaseEngine;
  replicas: number;
  poolSize: number;
}): string | null {
  // Object storage has no connection pool to run out of.
  if (input.engine === 's3') return null;
  const limit = input.engine === 'postgres' ? 100 : input.engine === 'redis' ? 10_000 : 151;
  const wanted = input.replicas * input.poolSize;
  if (wanted <= limit * 0.8) return null;
  return `${String(input.replicas)} copies of the app × ${String(input.poolSize)} connections each is ${String(wanted)}, and this database allows about ${String(limit)}. Lower the pool size, or run fewer copies.`;
}
