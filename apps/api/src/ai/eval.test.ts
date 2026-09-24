import {
  anthropicModel,
  points,
  scoreAssistant,
  scorecard,
  SCENARIOS,
  MAX_POINTS,
  type Scenario,
  type Scored,
} from '@vdeploy/ai';
import { ApplicationSpec, newId } from '@vdeploy/contracts';
import { hashOf } from '@vdeploy/core';
import { builds, observedState, projects, servers, uploads } from '@vdeploy/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, startTestApp, type TestApp } from '../test-helpers.js';

/**
 * The M3 eval (§26, §32): the assistant answers real broken deployments,
 * and is scored on naming the cause in words a person can act on and on
 * preparing the change that fixes it — or on leaving things alone when the
 * fix is in the person's own code.
 *
 * It calls a real model, so it runs only when a key is given:
 *   ANTHROPIC_API_KEY=… pnpm --filter @vdeploy/api test -- src/ai/eval.test.ts
 * Without one, the deterministic floor is still measured in
 * packages/ai/src/eval — VDeploy explains itself with no model at all.
 */
const apiKey = process.env.ANTHROPIC_API_KEY;
const PASSWORD = 'correct horse battery 42';
/** Out of 5 per scenario, over the whole set. */
const PASS_MARK = 0.8;

let t: TestApp;
let owner: Browser;
let orgId: string;
let serverId: string;

function specFor(scenario: Scenario) {
  return ApplicationSpec.parse({
    apiVersion: 'vdeploy/v1',
    kind: 'Application',
    metadata: { name: `eval-${scenario.id}` },
    source: { type: 'image', image: 'nginx:1.27' },
    build: { strategy: 'image' },
    ...(scenario.containerPort === null
      ? {}
      : { network: { containerPort: scenario.containerPort } }),
    runtime: { resources: { memory: { limit: scenario.memoryLimit } } },
  });
}

/** Seeds one broken project exactly as the agent would have reported it. */
async function seed(scenario: Scenario): Promise<string> {
  const spec = specFor(scenario);
  const projectId = newId('project');
  await t.database.db.insert(projects).values({
    id: projectId,
    orgId,
    serverId,
    name: `eval-${scenario.id}`,
    spec,
    specHash: hashOf(spec),
    currentReleaseId: newId('release'),
  });
  if (scenario.buildLog) {
    const uploadId = newId('upload');
    await t.database.db.insert(uploads).values({
      id: uploadId,
      orgId,
      sha256: 'f'.repeat(64),
      size: 1,
      createdBy: { userId: 'eval', origin: 'api' },
    });
    await t.database.db.insert(builds).values({
      id: newId('build'),
      orgId,
      projectId,
      serverId,
      uploadId,
      kind: 'build',
      strategy: 'railpack',
      options: { context: '.', args: {} },
      status: 'failed',
      log: scenario.buildLog,
      createdAt: new Date(),
    });
  }
  return projectId;
}

async function observe(entries: { projectId: string; scenario: Scenario }[]) {
  const report = {
    generation: 1,
    projects: entries.map(({ projectId, scenario }) => ({
      projectId,
      replicas: scenario.evidence.map((replica) => ({
        name: replica.container,
        state: replica.state,
        release: 'rel_eval',
      })),
      evidence: scenario.evidence,
    })),
    events: null,
  };
  await t.database.db
    .insert(observedState)
    .values({ serverId, generation: 1, report, receivedAt: new Date() })
    .onConflictDoUpdate({ target: observedState.serverId, set: { report } });
}

beforeAll(async () => {
  if (!apiKey) return;
  t = await startTestApp({
    model: anthropicModel({ apiKey, model: process.env.AI_MODEL ?? 'claude-opus-5' }),
  });
  owner = new Browser(t.app, 'Owner/1.0');
  const res = await owner.request('POST', '/api/v1/setup', {
    name: 'Owner',
    email: 'owner@example.com',
    password: PASSWORD,
    organization: 'Acme',
  });
  orgId = res.json<{ organizationId: string }>().organizationId;
  serverId = newId('server');
  await t.database.db
    .insert(servers)
    .values({ id: serverId, orgId, name: 'eval-01', status: 'online' });
}, 180_000);

afterAll(async () => {
  if (apiKey) await t.stop();
});

describe.skipIf(!apiKey)('the assistant on real broken deployments', () => {
  it(
    'names the cause and prepares the change a person would approve',
    async () => {
      const seeded = [];
      for (const scenario of SCENARIOS) {
        seeded.push({ scenario, projectId: await seed(scenario) });
      }
      await observe(seeded);

      const rows: Scored[] = [];
      for (const { scenario, projectId } of seeded) {
        const asked = await owner.request('POST', '/api/v1/ai/ask', {
          message: scenario.question,
          projectId,
          mode: 'propose',
        });
        expect(asked.statusCode).toBe(200);
        const answer = asked.json<{ sessionId: string; text: string }>();

        const fixed = await owner.request('POST', '/api/v1/ai/ask', {
          message: 'Fix it, if there is something here you can fix.',
          projectId,
          sessionId: answer.sessionId,
          mode: 'propose',
        });
        const second = fixed.json<{ text: string; proposals: { operation: string }[] }>();
        rows.push(
          scoreAssistant(scenario, {
            text: `${answer.text}\n${second.text}`,
            proposed: second.proposals.map((p) => p.operation),
          }),
        );
      }

      const card = scorecard('The assistant', rows);
      console.log(card);
      const scored = rows.reduce((sum, row) => sum + points(row), 0);
      const share = scored / (rows.length * MAX_POINTS);
      expect(share >= PASS_MARK || card).toBe(true);
    },
    30 * 60_000,
  );
});
