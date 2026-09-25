import { describe, expect, it } from 'vitest';
import {
  ago,
  dataLine,
  defaultEnvKey,
  ENGINE_VERSIONS,
  ENGINE_WORDS,
  ENGINES,
  offsiteWords,
  reachWords,
  SCHEDULES,
  scheduleWords,
  sizeWords,
  statusWords,
  type BackupSummary,
  type DatabaseSummary,
  type OffsiteSummary,
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
  backupPolicy: {
    enabled: true,
    expr: '0 3 * * *',
    timezone: 'UTC',
    keepLocal: 7,
    keepOffsite: 30,
  },
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

const backup = (over: Partial<BackupSummary> = {}): BackupSummary => ({
  id: 'bak_1',
  databaseId: 'db_1',
  databaseName: 'blog-db',
  status: 'done',
  kind: 'dump',
  reason: 'manual',
  sizeBytes: 4 * 1024 * 1024,
  verified: true,
  error: null,
  startedAt: '2026-09-24T00:00:00.000Z',
  finishedAt: '2026-09-24T00:01:00.000Z',
  offsiteAt: null,
  offsiteError: null,
  ...over,
});

describe('what a person is told about their data', () => {
  const now = Date.parse('2026-09-24T04:01:00.000Z');

  it('says plainly when there is only one copy of everything', () => {
    expect(dataLine([], now)).toEqual({
      tone: 'warning',
      words: 'No backups yet — your data exists in exactly one place.',
    });
    const failed = dataLine(
      [backup({ status: 'failed', verified: false, error: 'it was empty' })],
      now,
    );
    expect(failed.tone).toBe('warning');
    expect(failed.words).toContain('it was empty');
    expect(failed.words).toContain('exactly one place');
  });

  it('counts only a backup that was checked', () => {
    const unchecked = dataLine([backup({ verified: false })], now);
    expect(unchecked.tone).toBe('warning');
    const good = dataLine([backup()], now);
    expect(good).toEqual({
      tone: 'good',
      words: 'Last backup 4 hours ago, 4.0 MB, checked and readable.',
    });
  });

  it('says whether the copy left the server, because that is the whole point', () => {
    const away = dataLine([backup({ offsiteAt: '2026-09-24T00:02:00.000Z' })], now);
    expect(away).toEqual({
      tone: 'good',
      words: 'Last backup 4 hours ago, 4.0 MB, checked and readable. A copy is off the server.',
    });
    const stuck = dataLine([backup({ offsiteError: 'your storage refused the copy' })], now);
    expect(stuck.tone).toBe('warning');
    expect(stuck.words).toContain('The copy did not leave: your storage refused the copy');
  });

  it('writes sizes and ages the way people read them', () => {
    expect(sizeWords(null)).toBe('empty');
    expect(sizeWords(2048)).toBe('2 KB');
    expect(sizeWords(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(ago('2026-09-24T03:59:30.000Z', now)).toBe('2 minutes ago');
    expect(ago('2026-09-21T04:00:00.000Z', now)).toBe('3 days ago');
  });
});

describe('the backup schedule, in words', () => {
  const policy = {
    enabled: true,
    expr: '0 3 * * *',
    timezone: 'UTC',
    keepLocal: 7,
    keepOffsite: 30,
  };

  it('offers schedules people recognise, and says what one means', () => {
    expect(SCHEDULES.map((s) => s.expr)).toContain('0 3 * * *');
    expect(scheduleWords(policy)).toBe(
      'Backed up every day, at 3 in the morning (UTC), keeping 7 copies.',
    );
    expect(scheduleWords({ ...policy, timezone: 'Asia/Dhaka' })).toContain('(Asia/Dhaka)');
    expect(scheduleWords({ ...policy, expr: '5 4 * * 2' })).toContain('on the schedule 5 4 * * 2');
  });

  it('says plainly when nothing is scheduled', () => {
    expect(scheduleWords({ ...policy, enabled: false })).toBe('Not backed up automatically.');
  });
});

describe('where copies go', () => {
  const offsite = (over: Partial<OffsiteSummary> = {}): OffsiteSummary => ({
    target: {
      id: 'bkt_1',
      kind: 's3',
      repository: 's3:https://s3.eu-central-1.amazonaws.com/acme-backups/vdeploy',
      region: 'eu-central-1',
      status: 'ok',
      checkedAt: '2026-09-24T00:00:00.000Z',
      error: null,
      createdAt: '2026-09-24T00:00:00.000Z',
    },
    databasesAtRisk: 1,
    warning: null,
    dismissedAt: null,
    ...over,
  });

  it('says where they go, without the scheme nobody reads', () => {
    expect(offsiteWords(offsite())).toEqual({
      health: 'healthy',
      words: 'Copies go to s3.eu-central-1.amazonaws.com/acme-backups/vdeploy.',
    });
  });

  it('warns while data exists in exactly one place', () => {
    const none = offsiteWords(offsite({ target: null }));
    expect(none.health).toBe('warning');
    expect(none.words).toContain('stay on the servers');
    // Nothing to protect, or someone said they accept it: no standing warning.
    expect(offsiteWords(offsite({ target: null, databasesAtRisk: 0 })).health).toBe('neutral');
    expect(
      offsiteWords(offsite({ target: null, dismissedAt: '2026-09-24T00:00:00.000Z' })).health,
    ).toBe('neutral');
  });

  it('repeats the reason storage gave when it refused', () => {
    const broken = offsiteWords(
      offsite({
        target: { ...offsite().target!, status: 'failed', error: 'the key does not unlock it' },
      }),
    );
    expect(broken.health).toBe('failed');
    expect(broken.words).toContain('the key does not unlock it');
  });
});

describe('a target nobody has reached yet', () => {
  it('does not claim it works until a server says so', () => {
    const pending = offsiteWords({
      target: {
        id: 'bkt_1',
        kind: 's3',
        repository: 's3:https://s3.example.com/acme/vdeploy',
        region: null,
        status: 'pending',
        checkedAt: null,
        error: null,
        createdAt: '2026-09-25T00:00:00.000Z',
      },
      databasesAtRisk: 1,
      warning: null,
      dismissedAt: null,
    });
    expect(pending.health).toBe('warning');
    expect(pending.words).toContain('once a server has reached it');
  });
});
