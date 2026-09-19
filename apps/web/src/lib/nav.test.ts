import { describe, expect, it } from 'vitest';
import { activeItem, NAV } from './nav';

describe('navigation', () => {
  it('has unique routes', () => {
    expect(new Set(NAV.map((n) => n.href)).size).toBe(NAV.length);
  });

  it('highlights the most specific section, and Overview only at the root', () => {
    expect(activeItem('/')?.label).toBe('Overview');
    expect(activeItem('/projects/blog/deployments')?.label).toBe('Projects');
    expect(activeItem('/settings/security')?.label).toBe('Security');
    expect(activeItem('/nowhere')).toBeUndefined();
  });
});
