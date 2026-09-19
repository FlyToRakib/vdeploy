import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');

function tokens(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m): [string, string] => [
      m[1] ?? '',
      m[2] ?? '',
    ]),
  );
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const light = tokens(/:root \{([\s\S]*?)\}/.exec(css)![1]!);
const dark = tokens(/:root\[data-theme='dark'\] \{([\s\S]*?)\}/.exec(css)![1]!);
const darkMedia = tokens(/:root:not\(\[data-theme='light'\]\) \{([\s\S]*?)\}/.exec(css)![1]!);

// WCAG 2.2 AA: 4.5:1 for text. Every text-bearing pair in both themes.
const TEXT_PAIRS: [string, string][] = [
  ['foreground', 'background'],
  ['foreground', 'surface'],
  ['foreground', 'surface-raised'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'surface'],
  ['accent', 'background'],
  ['accent-foreground', 'accent'],
  ['status-healthy', 'status-healthy-bg'],
  ['status-warning', 'status-warning-bg'],
  ['status-failed', 'status-failed-bg'],
  ['status-neutral', 'status-neutral-bg'],
  ['status-healthy', 'background'],
  ['status-warning', 'background'],
  ['status-failed', 'background'],
];

describe('design tokens', () => {
  it('defines the same tokens in both themes', () => {
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
  });

  it('keeps the system-dark and explicit-dark themes identical', () => {
    expect(darkMedia).toEqual(dark);
  });

  for (const [theme, values] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    it.each(TEXT_PAIRS)(`${theme}: %s on %s meets 4.5:1`, (fg, bg) => {
      expect(contrast(values[fg]!, values[bg]!)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
