import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packFolder } from './pack.js';

function folder(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'vdeploy-pack-'));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, ...path.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

/** What an ordinary tar makes of it: the proof that the format is right. */
function unpack(archive: Buffer): { names: string[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vdeploy-unpack-'));
  // Relative to its own folder: GNU tar reads a drive letter as a remote host.
  writeFileSync(join(dir, 'a.tar.gz'), archive);
  const names = execFileSync('tar', ['-tzf', 'a.tar.gz'], { cwd: dir, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .sort();
  mkdirSync(join(dir, 'out'));
  execFileSync('tar', ['-xzf', '../a.tar.gz'], { cwd: join(dir, 'out') });
  return { names, dir: join(dir, 'out') };
}

describe('packFolder', () => {
  it('packs what the dashboard would, and nothing it would not', () => {
    const deep = `${'nested/'.repeat(16)}file.txt`;
    const root = folder({
      'package.json': '{"name":"shop"}',
      'src/index.js': 'console.log(1)',
      'node_modules/left/index.js': 'installed on the server',
      '.git/HEAD': 'ref: refs/heads/main',
      '.env': 'STRIPE_KEY=sk_live_stays_here',
      '.env.production': 'X=1',
      '.env.example': 'STRIPE_KEY=',
      [deep]: 'deep',
    });
    const packed = packFolder(root);
    expect(packed.secretsLeftOut.sort()).toEqual(['.env', '.env.production']);
    const { names, dir } = unpack(packed.archive);
    expect(names).toEqual(['.env.example', deep, 'package.json', 'src/index.js'].sort());
    expect(readFileSync(join(dir, 'src', 'index.js'), 'utf8')).toBe('console.log(1)');
    expect(readFileSync(join(dir, ...deep.split('/')), 'utf8')).toBe('deep');
    expect(packed.archive.toString('latin1')).not.toContain('sk_live');
    expect(packed.files).toBe(4);
  });
});
