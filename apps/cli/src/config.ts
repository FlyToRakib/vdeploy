import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where the CLI remembers which VDeploy it is talking to, and the key it
 * talks with.
 *
 * The key is a credential, so the file is written readable by its owner
 * and nobody else, and the directory is too. It is never printed back:
 * `vdeploy whoami` says which control plane and the first few characters,
 * which is enough to tell two keys apart and not enough to use one.
 */

export interface Settings {
  url: string;
  key: string;
}

export function configPath(): string {
  const base =
    process.env.VDEPLOY_CONFIG ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'vdeploy', 'config.json');
  return base;
}

export function readSettings(): Settings | null {
  // The environment wins, so a CI job needs no file and leaves none behind.
  const url = process.env.VDEPLOY_URL;
  const key = process.env.VDEPLOY_API_KEY;
  if (url && key) return { url: url.replace(/\/$/, ''), key };
  try {
    const raw: unknown = JSON.parse(readFileSync(configPath(), 'utf8'));
    if (
      typeof raw === 'object' &&
      raw !== null &&
      typeof (raw as Settings).url === 'string' &&
      typeof (raw as Settings).key === 'string'
    ) {
      const saved = raw as Settings;
      return { url: saved.url.replace(/\/$/, ''), key: saved.key };
    }
  } catch {
    // No file, or one somebody has edited into nonsense: either way there
    // is nothing to sign in with, and the caller says so in words.
  }
  return null;
}

export function writeSettings(settings: Settings): string {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  // Written again on an existing file, because the mode above only applies
  // when the file is created.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows has no mode to set; the file is in the user's own profile.
  }
  return path;
}

/** Enough of a key to tell two apart, never enough to use one. */
export function hint(key: string): string {
  return key.slice(0, 6) + '…' + key.slice(-2);
}
