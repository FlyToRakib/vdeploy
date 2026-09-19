import { describe, expect, it } from 'vitest';
import { ago, byAttention, bytes, serverHealth, splitCommand, type ServerSummary } from './servers';

describe('server status', () => {
  it('leads with what needs attention', () => {
    expect(serverHealth({ status: 'pending', reachable: null })).toEqual({
      health: 'neutral',
      label: 'Waiting to connect',
    });
    expect(serverHealth({ status: 'offline', reachable: 'reachable' }).label).toBe('Offline');
    expect(serverHealth({ status: 'online', reachable: 'blocked' })).toEqual({
      health: 'failed',
      label: 'Not reachable',
    });
    expect(serverHealth({ status: 'online', reachable: 'partly' }).health).toBe('warning');
    // Not checked yet is not a problem to show.
    expect(serverHealth({ status: 'online', reachable: null }).label).toBe('Online');
  });
});

describe('server order and fix steps', () => {
  const server = (
    name: string,
    status: ServerSummary['status'],
    reachable: ServerSummary['reachable'],
  ) => ({ name, status, reachable }) as ServerSummary;

  it('lists servers that need attention first', () => {
    const sorted = [
      server('b-ok', 'online', 'reachable'),
      server('a-ok', 'online', null),
      server('blocked', 'online', 'blocked'),
      server('new', 'pending', null),
    ].sort(byAttention);
    expect(sorted.map((s) => s.name)).toEqual(['blocked', 'new', 'a-ok', 'b-ok']);
  });

  it('separates the command to paste from the words around it', () => {
    expect(splitCommand('On the server itself: sudo ufw allow 80/tcp')).toEqual({
      text: 'On the server itself:',
      command: 'sudo ufw allow 80/tcp',
    });
    expect(splitCommand('Open the console.')).toEqual({ text: 'Open the console.', command: null });
  });
});

describe('human numbers', () => {
  const now = Date.parse('2026-09-20T12:00:00Z');
  it('says how long ago in words', () => {
    expect(ago(null, now)).toBe('never');
    expect(ago('2026-09-20T11:59:30Z', now)).toBe('just now');
    expect(ago('2026-09-20T11:59:00Z', now)).toBe('1 minute ago');
    expect(ago('2026-09-20T09:00:00Z', now)).toBe('3 hours ago');
    expect(ago('2026-09-15T12:00:00Z', now)).toBe('5 days ago');
  });

  it('writes memory as it is sold', () => {
    expect(bytes(2 * 1024 ** 3)).toBe('2 GB');
    expect(bytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
    expect(bytes(512 * 1024 ** 2)).toBe('512 MB');
  });
});
