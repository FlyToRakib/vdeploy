import { describe, expect, it } from 'vitest';
import { AgentFrame, EnrollRequest } from './agent.js';

const header = {
  v: 1,
  serverId: 'srv_01J9Z3Q8S7M2K4X6V1B5N0C9D8',
  nonce: 'nonce-0123456789abcdef',
  seq: 2,
  sentAt: '2026-09-19T13:26:54.63894581Z',
};

describe('AgentFrame', () => {
  it('accepts a report exactly as the Go agent encodes it (nil slices as null)', () => {
    const frame = AgentFrame.parse({
      ...header,
      type: 'observed_state',
      report: { generation: 3, projects: null, events: null },
    });
    expect(frame.type).toBe('observed_state');
  });

  it('accepts acks and hellos', () => {
    expect(
      AgentFrame.parse({ ...header, type: 'ack', generation: 3, accepted: false, error: 'x' }),
    ).toMatchObject({ accepted: false });
    expect(
      AgentFrame.parse({
        ...header,
        type: 'hello',
        agentVersion: 'dev',
        protocol: 1,
        generation: -1,
        hostname: 'srv',
        arch: 'amd64',
        os: 'linux',
        cpus: 2,
        memoryBytes: 1,
      }),
    ).toMatchObject({ type: 'hello' });
  });

  it('refuses anything else an agent might try to send', () => {
    expect(AgentFrame.safeParse({ ...header, type: 'desired_state', state: {} }).success).toBe(
      false,
    );
    expect(
      AgentFrame.safeParse({ ...header, type: 'ack', generation: 1, accepted: true, admin: true })
        .success,
    ).toBe(false);
    expect(
      AgentFrame.safeParse({
        ...header,
        type: 'observed_state',
        report: {
          generation: 1,
          projects: Array(201).fill({ projectId: 'p', replicas: null }),
          events: null,
        },
      }).success,
    ).toBe(false);
  });
});

describe('EnrollRequest', () => {
  it('needs a 32-byte public key in base64', () => {
    const base = {
      token: 'a'.repeat(43),
      hostname: 'h',
      arch: 'amd64',
      os: 'linux',
      agentVersion: 'dev',
      cpus: 2,
      memoryBytes: 1024,
    };
    const thirtyTwoZeroBytes = `${'A'.repeat(43)}=`;
    expect(EnrollRequest.safeParse({ ...base, publicKey: thirtyTwoZeroBytes }).success).toBe(true);
    expect(EnrollRequest.safeParse({ ...base, publicKey: 'short' }).success).toBe(false);
  });
});
