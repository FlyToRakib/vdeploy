import {
  anthropicModel,
  ModelUnavailable,
  revoyeModel,
  points,
  scoreAssistant,
  scorecard,
  SCENARIOS,
  MAX_POINTS,
  type ModelClient,
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
 * and/or REVOYE_API_KEY=… (and REVOYE_CHANNEL) for Revoye. Given both,
 * Claude takes 60% of the scenarios and Revoye 40%, spread evenly through
 * the run, so neither key carries it into its rate limit, and a busy
 * moment on one is answered by the other. Claude is Haiku unless AI_MODEL
 * names another: the cheapest that answers. Without a key, the
 * deterministic floor is still measured in packages/ai/src/eval —
 * VDeploy explains itself with no model at all.
 */
const env = process.env;
const claude = env.ANTHROPIC_API_KEY
  ? anthropicModel({ apiKey: env.ANTHROPIC_API_KEY, model: env.AI_MODEL ?? 'claude-haiku-4-5' })
  : null;
const revoye = env.REVOYE_API_KEY
  ? revoyeModel({
      apiKey: env.REVOYE_API_KEY,
      channel: (env.REVOYE_CHANNEL as 'auto' | 'cloud' | 'desk' | undefined) ?? 'auto',
      ...(env.REVOYE_BASE_URL ? { baseUrl: env.REVOYE_BASE_URL } : {}),
    })
  : null;
/** Claude's share of the scenarios when both keys are given; Revoye takes the rest. */
const CLAUDE_SHARE = 0.6;
/** Whose turn it is: the scenario's index. */
let turn = 0;
/** The scenario's provider first, the other as its stand-in; whichever exist. */
function providersFor(index: number): ModelClient[] {
  const claudes = Math.floor((index + 1) * CLAUDE_SHARE) > Math.floor(index * CLAUDE_SHARE);
  return (claudes ? [claude, revoye] : [revoye, claude]).filter((m) => m !== null);
}
const providerFor = () => providersFor(turn)[0]!;
const model: ModelClient | null =
  claude === null && revoye === null
    ? null
    : {
        get model() {
          return providerFor().model;
        },
        reply: async (request, signal) => {
          const order = providersFor(turn);
          for (const [i, current] of order.entries()) {
            try {
              return await current.reply(request, signal);
            } catch (error) {
              const busy = error instanceof ModelUnavailable && error.retryable;
              if (!busy || i === order.length - 1) throw error;
            }
          }
          throw new ModelUnavailable('No AI provider answered.', true);
        },
      };
const apiKey = model !== null;
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
  if (!model) return;
  t = await startTestApp({ model });
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
      for (const [index, { scenario, projectId }] of seeded.entries()) {
        turn = index;
        console.log(`${scenario.id}: ${providerFor().model}`);
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
    // Revoye answers in 3 to 90 seconds a step, so a full run can take an hour.
    2 * 60 * 60_000,
  );
});
