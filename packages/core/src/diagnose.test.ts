import type { ReplicaEvidence } from '@vdeploy/contracts';
import { describe, expect, it } from 'vitest';
import { diagnose, diagnoseBuild } from './diagnose.js';

const replica = (overrides: Partial<ReplicaEvidence>): ReplicaEvidence => ({
  container: 'vd-app-v1-r0-0',
  state: 'unhealthy',
  exitCode: null,
  oomKilled: false,
  restarts: 0,
  listening: null,
  lastOutput: '',
  ...overrides,
});

const conditionOf = (evidence: ReplicaEvidence, containerPort: number | null = 3000) =>
  diagnose({ containerPort, memoryLimit: '512Mi', evidence: [evidence] }).map((d) => d.condition);

describe('diagnose', () => {
  it('names the most common failure: listening on localhost', () => {
    const [d] = diagnose({
      containerPort: 3000,
      memoryLimit: '512Mi',
      evidence: [replica({ listening: ['127.0.0.1:3000', '[::1]:3000'] })],
    });
    expect(d?.condition).toBe('listening_on_localhost');
    expect(d?.plain).toMatch(/listen on 0\.0\.0\.0 instead of localhost/);
    expect(d?.confidence).toBe('high');
  });

  it('proposes the right port when the app answers on another one', () => {
    const [d] = diagnose({
      containerPort: 3000,
      memoryLimit: '512Mi',
      evidence: [replica({ listening: ['0.0.0.0:8080'] })],
    });
    expect(d).toMatchObject({ condition: 'wrong_port', proposal: { containerPort: 8080 } });
    expect(d?.plain).toBe("Your app answers on port 8080, but we're knocking on port 3000.");
  });

  it('tells a slow or silent app apart from one on the wrong address', () => {
    expect(conditionOf(replica({ listening: [] }))).toEqual(['not_listening']);
    expect(conditionOf(replica({ listening: ['0.0.0.0:3000'] }))).toEqual([]);
    expect(conditionOf(replica({ listening: ['[::]:3000'] }))).toEqual([]);
    expect(conditionOf(replica({ listening: null }))).toEqual([]);
  });

  it('says an app failing its readiness check is waiting, not broken, and not crashed', () => {
    const [d, ...rest] = diagnose({
      containerPort: 3000,
      memoryLimit: '512Mi',
      readinessPath: '/ready',
      // Listening where it should: the platform can reach it, the app says no.
      evidence: [replica({ state: 'not_ready', listening: ['0.0.0.0:3000'] })],
    });
    expect(rest).toEqual([]);
    expect(d?.condition).toBe('readiness_failing');
    expect(d?.plain).toMatch(/says it is not ready at \/ready, so it gets no visitors/);
    expect(d?.plain).toMatch(/It is not restarted/);
    // Not the crash-loop sentence, even with restarts behind it.
    expect(conditionOf(replica({ state: 'not_ready', restarts: 1 }))).toEqual([
      'readiness_failing',
    ]);
  });

  it('says out of memory when the kernel killed it', () => {
    const [d] = diagnose({
      containerPort: 3000,
      memoryLimit: '256Mi',
      evidence: [replica({ state: 'exited', exitCode: 137, oomKilled: true })],
    });
    expect(d?.condition).toBe('out_of_memory');
    expect(d?.plain).toMatch(/256Mi/);
  });

  it.each([
    ['Error: environment variable DATABASE_URL is not set', 'missing_env_var', /DATABASE_URL/],
    ["KeyError: 'SECRET_KEY'", 'missing_env_var', /SECRET_KEY/],
    ['Error: connect ECONNREFUSED 10.0.0.5:5432', 'database_unreachable', /database/],
    ['Error: listen EADDRINUSE: address already in use :::3000', 'port_in_use', /port/],
    ["Error: Cannot find module './Header'", 'module_not_found', /case-sensitive/],
    ['error: This app requires Node.js >= 20', 'runtime_version', /version 20/],
  ])('reads a crash from its last words: %s', (output, condition, plain) => {
    const [d] = diagnose({
      containerPort: 3000,
      memoryLimit: '512Mi',
      evidence: [replica({ state: 'exited', exitCode: 1, restarts: 5, lastOutput: output })],
    });
    expect(d?.condition).toBe(condition);
    expect(d?.plain).toMatch(plain);
  });

  it('falls back to the last words it cannot name, with medium confidence', () => {
    const [d] = diagnose({
      containerPort: 3000,
      memoryLimit: '512Mi',
      evidence: [replica({ state: 'exited', exitCode: 2, lastOutput: 'line 1\nsomething odd\n' })],
    });
    expect(d).toMatchObject({ condition: 'crash_loop', confidence: 'medium' });
    expect(d?.plain).toMatch(/something odd/);
  });

  it("quotes the app's own last words, not its package manager's wrapping", () => {
    // What sopost-web printed on each restart, live: pnpm's lines come last.
    const once = [
      '$ pnpm --filter @sopost/server start',
      '$ tsx src/index.ts',
      '{"level":60,"pid":59,"msg":"Couldn\'t access platform storage: PermissionDenied\\n\\nCaused by:\\n    PermissionDenied"}',
      '/app/apps/server:',
      '[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @sopost/server@1.0.0 start: `tsx src/index.ts`',
      'Exit status 1',
      '[ELIFECYCLE] Command failed with exit code 1.',
    ].join('\n');
    const [d] = diagnose({
      containerPort: 4545,
      memoryLimit: '512Mi',
      evidence: [replica({ state: 'restarting', restarts: 8, lastOutput: `${once}\n${once}\n` })],
    });
    expect(d?.plain).toBe(
      "Your app keeps stopping right after it starts. The last thing it said was: Couldn't access platform storage: PermissionDenied",
    );
    expect(d?.detected).toBe('the app stopped after 8 restarts');
  });

  it('shows the wrapping when it is all there is, and names a known exit code', () => {
    const [d] = diagnose({
      containerPort: 3000,
      memoryLimit: '512Mi',
      evidence: [replica({ state: 'exited', exitCode: 1, lastOutput: 'Exit status 1\n' })],
    });
    expect(d?.plain).toMatch(/said was: Exit status 1$/);
    expect(d?.detected).toBe('the app stopped with exit code 1 after 0 restarts');
  });

  it('reports each cause once across replicas', () => {
    const same = replica({ listening: ['127.0.0.1:3000'] });
    expect(
      diagnose({ containerPort: 3000, memoryLimit: '512Mi', evidence: [same, same] }),
    ).toHaveLength(1);
  });
});

describe('diagnoseBuild', () => {
  it.each([
    ['npm ERR! Missing script: "build"', 'build_missing_script'],
    ["Module not found: Error: Can't resolve './components/Header'", 'build_module_not_found'],
    [
      'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
      'build_out_of_memory',
    ],
    ['npm ERR! code ERESOLVE', 'build_dependency_install'],
  ])('names %s', (log, condition) => {
    expect(diagnoseBuild(log)?.condition).toBe(condition);
  });

  it('stays quiet about what it does not know', () => {
    expect(diagnoseBuild('#5 DONE 0.1s')).toBeNull();
  });
});
