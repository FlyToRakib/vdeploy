import { describe, expect, it } from 'vitest';
import { AiCallWindow } from './ai-calls.js';

describe('AiCallWindow', () => {
  it('counts the calls before this one inside the minute, per session', () => {
    const window = new AiCallWindow();
    expect(window.hit('a', 0)).toBe(0);
    expect(window.hit('a', 1_000)).toBe(1);
    expect(window.hit('b', 1_000)).toBe(0);
    // A minute after the first, only the second is still inside.
    expect(window.hit('a', 60_000)).toBe(1);
  });

  it('forgets sessions that went quiet once there are many', () => {
    const window = new AiCallWindow();
    for (let i = 0; i < 1001; i++) window.hit(`s${String(i)}`, 0);
    window.hit('late', 120_000);
    expect(window.hit('s0', 120_001)).toBe(0);
    expect((window as unknown as { calls: Map<string, number[]> }).calls.size).toBeLessThan(10);
  });
});
