import { describe, expect, it } from 'vitest';
import {
  byProjectAttention,
  describeDetection,
  projectName,
  uploadPlan,
  type ProjectSummary,
} from './projects';

describe('detection preview', () => {
  it('names the runtime, its version and how the app starts', () => {
    const summary = describeDetection({
      detectedProviders: ['node'],
      resolvedPackages: {
        node: { name: 'node', requestedVersion: '22', resolvedVersion: '22.11.0' },
      },
      plan: { deploy: { startCmd: 'npm run start' } },
      logs: [
        { level: 'info', msg: 'Using npm' },
        { level: 'warn', msg: 'No lock file found' },
      ],
    });
    expect(summary).toEqual({
      runtime: 'Node.js 22.11.0',
      staticSite: false,
      startCommand: 'npm run start',
      warnings: ['No lock file found'],
    });
  });

  it('recognises a single-page app and survives a report it does not know', () => {
    expect(
      describeDetection({ detectedProviders: ['node'], metadata: { nodeSPA: 'true' } }).staticSite,
    ).toBe(true);
    expect(describeDetection(null)).toEqual({
      runtime: null,
      staticSite: false,
      startCommand: null,
      warnings: [],
    });
  });
});

describe('folder uploads', () => {
  it('leaves out dependencies, git history and secrets files', () => {
    const plan = uploadPlan([
      'site/package.json',
      'site/src/index.js',
      'site/node_modules/react/index.js',
      'site/.git/HEAD',
      'site/.env',
      'site/.env.production',
      'site/.env.example',
      'site/sub/.DS_Store',
    ]);
    expect(plan.keep).toEqual(['package.json', 'src/index.js', '.env.example']);
    expect(plan.secretsLeftOut).toEqual(['.env', '.env.production']);
  });

  it('leaves out what the folder keeps out of git, as `vdeploy up` does', () => {
    const plan = uploadPlan(
      [
        'site/.gitignore',
        'site/package.json',
        'site/data/app.db',
        'site/data/profiles/Cookies',
        'site/apps/server/src/data/schema.ts',
        'site/apps/web/.gitignore',
        'site/apps/web/generated/big.js',
        'site/apps/web/src/main.ts',
      ],
      [
        { dir: '', text: '/data/\n*.db\n' },
        { dir: 'apps/web', text: 'generated/\n' },
      ],
    );
    expect(plan.keep).toEqual([
      '.gitignore',
      'package.json',
      'apps/server/src/data/schema.ts',
      'apps/web/.gitignore',
      'apps/web/src/main.ts',
    ]);
  });
});

describe('project order', () => {
  it('lists what is down first', () => {
    const p = (name: string, state: ProjectSummary['state']) => ({ name, state }) as ProjectSummary;
    const sorted = [p('b', 'live'), p('a', 'live'), p('x', 'down'), p('y', 'deploying')].sort(
      byProjectAttention,
    );
    expect(sorted.map((s) => s.name)).toEqual(['x', 'y', 'a', 'b']);
  });
});

describe('project names', () => {
  it('turns what people have into a valid name', () => {
    expect(projectName('My Site_v2.zip')).toBe('my-site-v2');
    expect(projectName('acme/Shop.API')).toBe('shop-api');
    expect(projectName('ghcr.io/acme/web:1.4')).toBe('web');
    expect(projectName('nginx@sha256:abc')).toBe('nginx');
    expect(projectName('2024-portfolio')).toBe('app-2024-portfolio');
    expect(projectName('---')).toBe('my-app');
  });
});
