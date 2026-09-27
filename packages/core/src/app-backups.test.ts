import { ApplicationSpec } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { buildPlan } from './plan.js';

const MiB = 1024 * 1024;
const server = {
  name: 'server-01',
  capacity: { memoryBytes: 8192 * MiB, cpus: 4 },
  committed: { memoryBytes: 0, cpu: 0 },
};

const withFolders = ApplicationSpec.parse({
  apiVersion: 'vdeploy/v1',
  kind: 'Application',
  metadata: { name: 'shop' },
  source: { type: 'image', image: 'nginx:1.27' },
  build: { strategy: 'image' },
  network: { containerPort: 80 },
  runtime: { volumes: [{ name: 'uploads', mountPath: '/app/uploads' }] },
});

const projectId = 'prj_01J9Z3Q8S7M2K4X6V1B5N0C9D8' as never;
const databaseId = 'dbs_01J9Z3Q8S7M2K4X6V1B5N0C9D8' as never;
const backupId = 'bkp_01J9Z3Q8S7M2K4X6V1B5N0C9D8' as never;

const project = (spec = withFolders) => ({
  id: projectId,
  spec,
  running: true,
  currentReleaseId: 'rel_01J9Z3Q8S7M2K4X6V1B5N0C9D8' as never,
  replicas: 1,
});

const context = (over: Record<string, unknown> = {}) => ({
  project: project(),
  server,
  linkedDatabases: [{ id: databaseId, name: 'shop-db' }],
  ...over,
});

describe('backing up an app rather than a thing (§17.4)', () => {
  it('copies its databases first, then its folders', () => {
    // Folders newer than the data they describe is a shop whose orders and
    // whose product images are from different days.
    const plan = buildPlan('backup.trigger', { projectId }, context());
    expect(plan.steps).toEqual([
      { kind: 'take_backup', databaseId },
      { kind: 'snapshot_volumes', volumes: ['uploads'] },
    ]);
    expect(plan.tier).toBe('safe');
    expect(plan.changes[0]?.after).toContain('shop-db and uploads');
  });

  it('copies only what there is', () => {
    const noDatabase = buildPlan('backup.trigger', { projectId }, context({ linkedDatabases: [] }));
    expect(noDatabase.steps.map((s) => s.kind)).toEqual(['snapshot_volumes']);

    const noFolders = buildPlan(
      'backup.trigger',
      { projectId },
      context({ project: project(ApplicationSpec.parse({ ...withFolders, runtime: {} })) }),
    );
    expect(noFolders.steps.map((s) => s.kind)).toEqual(['take_backup']);
  });

  it('says so when there is nothing to copy, rather than making an empty plan', () => {
    expect(() =>
      buildPlan(
        'backup.trigger',
        { projectId },
        context({
          linkedDatabases: [],
          project: project(ApplicationSpec.parse({ ...withFolders, runtime: {} })),
        }),
      ),
    ).toThrow(/nothing to back up/);
  });

  it('sets one schedule across every database the app reads', () => {
    const plan = buildPlan(
      'backup.schedule',
      { projectId, expr: '0 3 * * *', timezone: 'Europe/London', keepLocal: 7, keepOffsite: 30 },
      context({
        linkedDatabases: [
          { id: databaseId, name: 'shop-db' },
          { id: 'dbs_01J9Z3Q8S7M2K4X6V1B5N0C9E9' as never, name: 'shop-cache' },
        ],
      }),
    );
    expect(plan.steps.map((s) => s.kind)).toEqual(['set_backup_policy', 'set_backup_policy']);
    expect(plan.changes[0]?.after).toContain('Europe/London');
  });
});

describe('putting a copy of an app back (§17.5)', () => {
  const dump = { id: backupId, kind: 'dump' as const, databaseId };
  const folders = { id: backupId, kind: 'volumes' as const, databaseId: null };

  it('does the right thing for each kind, without anybody choosing which', () => {
    const database = buildPlan(
      'backup.restore',
      { projectId, backupId, mode: 'in_place' },
      context({ targetBackup: dump }),
    );
    expect(database.steps.some((s) => s.kind === 'restore_backup')).toBe(true);

    const files = buildPlan(
      'backup.restore',
      { projectId, backupId, mode: 'new' },
      context({ targetBackup: folders }),
    );
    // Folders go back the way they always do: a copy first, stopped, put
    // back, started again.
    expect(files.steps.map((s) => s.kind)).toEqual([
      'snapshot_volumes',
      'stop',
      'restore_volumes',
      'start',
    ]);
  });

  it('is destructive only when it replaces what is there', () => {
    const over = buildPlan(
      'backup.restore',
      { projectId, backupId, mode: 'in_place' },
      context({ targetBackup: dump }),
    );
    expect(over.tier).toBe('destructive');
    expect(over.blastRadius.dataAtRisk).not.toEqual([]);

    const beside = buildPlan(
      'backup.restore',
      { projectId, backupId, mode: 'new' },
      context({ targetBackup: dump }),
    );
    expect(beside.tier).toBe('sensitive');
    expect(beside.blastRadius.dataAtRisk).toEqual([]);
  });

  it('refuses a backup that is not this app’s', () => {
    expect(() =>
      buildPlan('backup.restore', { projectId, backupId, mode: 'new' }, context()),
    ).toThrow(/not one of this app/);
  });
});
