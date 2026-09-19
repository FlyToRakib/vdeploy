import { describe, expect, it } from 'vitest';
import { appendLines, asText, eventWords, filterLines, replicaLabel, type LogLine } from './logs';

const line = (text: string, n = 0): LogLine => ({
  container: `vd-abc-v5-r0-${String(n)}`,
  stream: 'out',
  time: '2026-09-20T10:00:00Z',
  text,
});

describe('log viewer', () => {
  it('keeps the newest lines when the buffer is full', () => {
    const kept = appendLines([line('a'), line('b')], [line('c'), line('d')], 3);
    expect(kept.map((l) => l.text)).toEqual(['b', 'c', 'd']);
  });

  it('searches without caring about case', () => {
    const lines = [line('Listening on 3000'), line('ERROR: db down'), line('ok')];
    expect(filterLines(lines, 'error').map((l) => l.text)).toEqual(['ERROR: db down']);
    expect(filterLines(lines, '  ')).toHaveLength(3);
  });

  it('downloads as plain text, one line each', () => {
    expect(asText([line('hi')])).toBe('2026-09-20T10:00:00Z vd-abc-v5-r0-0 out hi');
  });

  it('names copies and events in words', () => {
    expect(replicaLabel('vd-abc-v5-r0-1')).toBe('v5 #2');
    expect(replicaLabel('something-else')).toBe('something-else');
    expect(eventWords('healed')).toBe('Restarted after a crash');
    expect(eventWords('new_kind')).toBe('new kind');
  });
});
