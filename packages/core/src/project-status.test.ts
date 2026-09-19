import { describe, expect, it } from 'vitest';
import { projectState } from './project-status.js';

const ready = [{ state: 'ready' }, { state: 'ready' }];

describe('project state', () => {
  it('names each case in one word', () => {
    const base = { running: true, hasRelease: true, deployment: 'succeeded', replicas: ready };
    expect(projectState(base)).toBe('live');
    expect(projectState({ ...base, running: false })).toBe('stopped');
    expect(projectState({ ...base, deployment: 'running' })).toBe('deploying');
    // The old version still serves after a failed deploy: working, but needs a look.
    expect(projectState({ ...base, deployment: 'rolled_back' })).toBe('failing');
    expect(projectState({ ...base, replicas: [{ state: 'ready' }, { state: 'exited' }] })).toBe(
      'failing',
    );
    expect(projectState({ ...base, replicas: [{ state: 'exited' }] })).toBe('down');
    expect(projectState({ ...base, replicas: null })).toBe('down');
    expect(
      projectState({ running: true, hasRelease: false, deployment: null, replicas: null }),
    ).toBe('new');
    expect(
      projectState({ running: true, hasRelease: false, deployment: 'failed', replicas: null }),
    ).toBe('down');
  });
});
