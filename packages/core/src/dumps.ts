/**
 * Reading what a dump from another host actually is (§17.5). The way in from
 * anywhere else is a file someone exported months ago and half remembers, so
 * VDeploy looks at the bytes rather than the file name — and says plainly
 * when it is the wrong shape, or came from a newer engine than the one it is
 * being loaded into, instead of failing half way through.
 */

/** How much of a dump says what it is; a header is never further in than this. */
export const DUMP_HEAD_BYTES = 64 * 1024;

export type DumpFormat = 'postgres-custom' | 'sql' | 'redis-rdb' | 'gzip';

export interface DumpFacts {
  format: DumpFormat | null;
  /** The engine that wrote it, when the dump says so. */
  engine: 'postgres' | 'mysql' | 'mariadb' | null;
  /** The engine version that wrote it, when the dump says so. */
  version: string | null;
}

/** `-- Dumped from database version 16.2` — what `pg_dump` writes in plain SQL. */
const PG_VERSION = /--\s*Dumped from database version\s+(\d+(?:\.\d+)*)/i;
/** `-- Server version	8.0.36` — what `mysqldump` writes. */
const MYSQL_VERSION = /--\s*Server version\s+(\d+(?:\.\d+)*)(?:-MariaDB)?/i;
const MARIADB = /MariaDB/i;

/**
 * What the first bytes of a dump say about it. A custom-format `pg_dump`
 * carries its server version only inside the archive header, which needs
 * `pg_restore` to read, so the format is known but the version is not — and
 * an unknown version is reported as unknown rather than guessed.
 */
export function sniffDump(head: Buffer | Uint8Array): DumpFacts {
  const bytes = Buffer.from(head);
  if (bytes.subarray(0, 5).toString('latin1') === 'PGDMP') {
    return { format: 'postgres-custom', engine: 'postgres', version: null };
  }
  if (bytes.subarray(0, 5).toString('latin1') === 'REDIS') {
    return { format: 'redis-rdb', engine: null, version: null };
  }
  // Compressed: a gzipped dump, or a backup of object storage — an archive
  // of its folder (ADR 0026), which the agent checks is a store.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return { format: 'gzip', engine: null, version: null };
  }
  const text = bytes.toString('utf8');
  const postgres = PG_VERSION.exec(text);
  if (postgres) return { format: 'sql', engine: 'postgres', version: postgres[1] ?? null };
  const mysql = MYSQL_VERSION.exec(text);
  if (mysql) {
    return {
      format: 'sql',
      engine: MARIADB.test(text) ? 'mariadb' : 'mysql',
      version: mysql[1] ?? null,
    };
  }
  // Plain SQL that says nothing about itself is still SQL: statements, or
  // the comments and settings every dumper writes before them.
  if (/^\s*(--|\/\*|SET\s|CREATE\s|INSERT\s|DROP\s|BEGIN;|START TRANSACTION)/i.test(text)) {
    return { format: 'sql', engine: null, version: null };
  }
  return { format: null, engine: null, version: null };
}

/** The major version: what actually decides whether a dump will load. */
export function majorOf(version: string): number {
  return Number.parseInt(version.split('.')[0] ?? '', 10);
}

/**
 * Why this dump cannot be loaded into this database, in words — or null when
 * nothing stands in the way. A dump from an older engine loads into a newer
 * one; the other way round does not, and finding that out half way through a
 * restore is how people lose an afternoon and trust the tool less.
 */
export function dumpRefusal(
  facts: DumpFacts,
  target: { engine: string; version: string },
): string | null {
  if (!facts.format) {
    return 'That file is not a database dump VDeploy can read. Export it with pg_dump, mysqldump, or as plain SQL.';
  }
  // Engines whose dumps are a format of their own take that and nothing else;
  // what is inside is checked on the server before anything is replaced.
  if (target.engine === 's3') {
    return facts.format === 'gzip'
      ? null
      : 'Object storage takes an archive of a store, as VDeploy backs one up — not a database dump.';
  }
  if (target.engine === 'mongodb') {
    return facts.format === 'gzip'
      ? null
      : 'MongoDB takes an archive made with mongodump --archive --gzip.';
  }
  if (target.engine === 'redis') {
    return facts.format === 'redis-rdb'
      ? null
      : 'Redis takes a dump Redis made: an .rdb file, such as from redis-cli --rdb.';
  }
  if (facts.format === 'gzip') {
    return 'That file is compressed. Unpack it (gunzip) and upload the dump inside.';
  }
  if (facts.format === 'redis-rdb') {
    return `That is a Redis dump, and ${target.engine} cannot read it.`;
  }
  if (facts.format === 'postgres-custom' && target.engine !== 'postgres') {
    return `That is a PostgreSQL dump, and ${target.engine} cannot read it.`;
  }
  const family = (engine: string) => (engine === 'mariadb' ? 'mysql' : engine);
  if (facts.engine && family(facts.engine) !== family(target.engine)) {
    return `That dump came from ${facts.engine}, and this database is ${target.engine}. Export it again from ${target.engine}, or make a ${facts.engine} database to load it into.`;
  }
  // Only within one engine: MariaDB 11 and MySQL 8 are not eleven and eight
  // of the same thing, and they read each other's dumps anyway.
  if (facts.version && facts.engine === target.engine) {
    const from = majorOf(facts.version);
    const into = majorOf(target.version);
    if (Number.isFinite(from) && Number.isFinite(into) && from > into) {
      return `That dump came from ${facts.engine} ${facts.version}, and this database is ${target.version}. An older version cannot read a newer one's dump — make a ${String(from)} database and load it into that.`;
    }
  }
  return null;
}
