import { describe, expect, it } from 'vitest';
import { CANARY_SOAK_MS, updateDecision, type FleetServer } from './agent-updates.js';

const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const served = { amd64: NEW, arm64: 'c'.repeat(64) };
const now = new Date('2026-09-30T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

const server = (overrides: Partial<FleetServer> = {}): FleetServer => ({
  id: `srv_${Math.random().toString(36).slice(2)}`,
  channel: 'general',
  online: true,
  arch: 'amd64',
  binarySha: OLD,
  updateAskedAt: null,
  updatedAt: null,
  ...overrides,
});

describe('updateDecision', () => {
  it('leaves a current agent alone, and one that cannot say which build it is', () => {
    const current = server({ binarySha: NEW });
    expect(updateDecision(current, [current], served, now)).toEqual({
      ask: false,
      reason: 'current',
    });
    const ancient = server({ binarySha: null });
    expect(updateDecision(ancient, [ancient], served, now)).toEqual({
      ask: false,
      reason: 'unknown',
    });
  });

  it('updates a canary at once, and asks nobody twice in a row', () => {
    const canary = server({ channel: 'canary' });
    expect(updateDecision(canary, [canary], served, now)).toEqual({ ask: true });
    const asked = server({ channel: 'canary', updateAskedAt: ago(60_000) });
    expect(updateDecision(asked, [asked], served, now)).toEqual({ ask: false, reason: 'asked' });
  });

  it('holds everyone else until every canary has run the new build for half an hour', () => {
    const general = server();
    const pending = server({ channel: 'canary' });
    expect(updateDecision(general, [general, pending], served, now)).toEqual({
      ask: false,
      reason: 'canaries',
    });
    const fresh = server({ channel: 'canary', binarySha: NEW, updatedAt: ago(5 * 60_000) });
    expect(updateDecision(general, [general, fresh], served, now)).toEqual({
      ask: false,
      reason: 'soaking',
    });
    const soaked = server({ channel: 'canary', binarySha: NEW, updatedAt: ago(CANARY_SOAK_MS) });
    expect(updateDecision(general, [general, soaked], served, now)).toEqual({ ask: true });
    // A canary that is offline holds nobody back.
    const away = server({ channel: 'canary', online: false });
    expect(updateDecision(general, [general, away], served, now)).toEqual({ ask: true });
  });

  it('goes a quarter of the fleet at a time', () => {
    const fleet = Array.from({ length: 8 }, () => server());
    fleet[0]!.updateAskedAt = ago(60_000);
    fleet[1]!.updateAskedAt = ago(60_000);
    expect(updateDecision(fleet[2]!, fleet, served, now)).toEqual({ ask: false, reason: 'wave' });
    // One of the wave came back as the new build: room for one more.
    fleet[1]!.binarySha = NEW;
    expect(updateDecision(fleet[2]!, fleet, served, now)).toEqual({ ask: true });
  });

  it('asks for the build that matches the processor', () => {
    const arm = server({ arch: 'arm64', binarySha: 'c'.repeat(64) });
    expect(updateDecision(arm, [arm], served, now)).toEqual({ ask: false, reason: 'current' });
  });
});
