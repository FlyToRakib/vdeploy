import { describe, expect, it } from 'vitest';
import {
  AUTO_APPLY_WORDS,
  modeBlurb,
  MODES,
  money,
  projectFromPath,
  READ_WORDS,
  spendWords,
  type ReadCategory,
  windowDays,
} from './ai';

const CATEGORIES: ReadCategory[] = [
  'config',
  'deployHistory',
  'logs',
  'metrics',
  'secretNames',
  'sourceFiles',
];

describe('the assistant in plain words', () => {
  it('says what each mode does, in words with no jargon', () => {
    expect(MODES.map((m) => m.value)).toEqual(['ask', 'propose', 'autopilot']);
    for (const mode of MODES) {
      expect(mode.blurb).toMatch(/\.$/);
      expect(mode.blurb).not.toMatch(/tier|gate|policy|token/i);
    }
  });

  it('explains why a session that read the app’s output can only propose', () => {
    expect(modeBlurb('autopilot', false)).toBe('May make small changes on its own.');
    expect(modeBlurb('autopilot', true)).toContain('every change waits for you');
    expect(modeBlurb('ask', true)).toContain('every change waits for you');
  });

  it('has words for every kind of read and every auto-apply tier', () => {
    for (const category of CATEGORIES) expect(READ_WORDS[category]).toBeTruthy();
    expect(Object.keys(READ_WORDS).sort()).toEqual([...CATEGORIES].sort());
    expect(Object.keys(AUTO_APPLY_WORDS)).toEqual(['safe', 'sensitive']);
    expect(READ_WORDS.secretNames).toContain('never their values');
  });

  it('shows money the way a person reads it', () => {
    expect(money(0)).toBe('$0.00');
    expect(money(0.004)).toBe('less than a cent');
    expect(money(1.2)).toBe('$1.20');
    expect(spendWords(1.2, 50)).toBe('$1.20 of $50 this month');
  });

  it('follows the person to the project they are looking at', () => {
    expect(projectFromPath('/projects/prj_123/logs')).toBe('prj_123');
    expect(projectFromPath('/projects/prj_123')).toBe('prj_123');
    expect(projectFromPath('/projects')).toBeUndefined();
    expect(projectFromPath('/servers/srv_1')).toBeUndefined();
  });
});

describe('windowDays', () => {
  it('names the day sets the screen offers, and nothing else', () => {
    expect(windowDays([5, 1, 2, 3, 4])).toBe('weekdays');
    expect(windowDays([6, 0])).toBe('weekends');
    expect(windowDays([0, 1, 2, 3, 4, 5, 6])).toBe('every');
    // A mix somebody set through the API is kept, not rounded to a name.
    expect(windowDays([1, 3])).toBeNull();
  });
});
