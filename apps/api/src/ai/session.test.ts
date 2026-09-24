import {
  ModelUnavailable,
  scriptedModel,
  type ModelClient,
  type ModelRequest,
  type ScriptedReply,
} from '@vdeploy/ai';
import { ApplicationSpec, DEFAULT_AI_GRANTS, newId } from '@vdeploy/contracts';
import { hashOf } from '@vdeploy/core';
import { aiGrants, aiMessages, aiSessions, plans, projects } from '@vdeploy/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { Browser, startTestApp, testConfig, type TestApp } from '../test-helpers.js';

let t: TestApp;
let owner: Browser;
let orgId: string;
let projectId: string;

const PASSWORD = 'correct horse battery 42';

const spec = ApplicationSpec.parse({
  apiVersion: 'vdeploy/v1',
  kind: 'Application',
  metadata: { name: 'blog' },
  source: { type: 'image', image: 'nginx:1.27' },
  build: { strategy: 'image' },
});

/** A model whose script each test sets, standing in for the real one. */
interface Stand extends ModelClient {
  script: (replies: ScriptedReply[]) => void;
  fail: (error: Error) => void;
  seen: ModelRequest[];
}

function standIn(): Stand {
  let inner = scriptedModel([], 'claude-opus-5');
  let error: Error | null = null;
  const seen: ModelRequest[] = [];
  return {
    model: 'claude-opus-5',
    script: (replies) => {
      inner = scriptedModel(replies, 'claude-opus-5');
      error = null;
    },
    fail: (next) => {
      error = next;
    },
    seen,
    reply: (request) => {
      seen.push(request);
      if (error) return Promise.reject(error);
      return inner.reply(request);
    },
  };
}

const model = standIn();

function ask(body: Record<string, unknown>) {
  return owner.request('POST', '/api/v1/ai/ask', body);
}

function op(name: string, input: unknown) {
  return owner.request('POST', `/api/v1/operations/${name}`, { input });
}

async function stepUp() {
  const res = await owner.request('POST', '/api/v1/auth/step-up', { password: PASSWORD });
  expect(res.statusCode).toBe(204);
}

interface AskBody {
  sessionId: string;
  text: string;
  tainted: boolean;
  proposals: { id: string; planId: string; operation: string; title: string }[];
  applied: { operation: string }[];
}

async function setGrants(change: Record<string, unknown>) {
  const grants = { ...DEFAULT_AI_GRANTS, ...change };
  await t.database.db
    .insert(aiGrants)
    .values({ orgId, grants, updatedAt: new Date() })
    .onConflictDoUpdate({ target: aiGrants.orgId, set: { grants } });
}

beforeAll(async () => {
  t = await startTestApp({ model });
  owner = new Browser(t.app, 'Owner/1.0');
  const res = await owner.request('POST', '/api/v1/setup', {
    name: 'Owner',
    email: 'owner@example.com',
    password: PASSWORD,
    organization: 'Acme',
  });
  orgId = res.json<{ organizationId: string }>().organizationId;
  projectId = newId('project');
  await t.database.db.insert(projects).values({
    id: projectId,
    orgId,
    name: 'blog',
    spec,
    specHash: hashOf(spec),
    currentReleaseId: newId('release'),
  });
}, 120_000);

afterAll(async () => {
  await t.stop();
});

describe('the assistant', () => {
  it('turns a change into a proposal a person approves, never an applied change', async () => {
    model.script([
      {
        text: 'Stopping the blog takes the site offline until you start it again.',
        toolCalls: [{ name: 'project_stop', input: { projectId } }],
      },
      { text: 'I have prepared it; approve it when you are ready.' },
    ]);
    const res = await ask({ message: 'Take the blog offline', projectId, mode: 'propose' });
    expect(res.statusCode).toBe(200);
    const body = res.json<AskBody>();
    expect(body.proposals).toHaveLength(1);
    expect(body.applied).toHaveLength(0);
    expect(t.queued).toHaveLength(0);

    const [plan] = await t.database.db
      .select()
      .from(plans)
      .where(eq(plans.id, body.proposals[0]?.planId ?? ''));
    expect(plan?.status).toBe('pending_approval');
    expect(plan?.reasons).toContain('The AI session is in propose mode');

    const listed = await owner.request('GET', '/api/v1/ai/proposals');
    const [proposal] = listed.json<{ title: string; plain: string; tier: string }[]>();
    expect(proposal?.tier).toBe('sensitive');
    expect(proposal?.title).toBe(
      'Stopping the blog takes the site offline until you start it again.',
    );
    expect(proposal?.plain).toContain('offline');
  });

  it('never hands a mutating tool to a session that is only allowed to answer', async () => {
    model.script([
      { text: 'Let me stop it.', toolCalls: [{ name: 'project_stop', input: { projectId } }] },
      { text: 'I cannot change anything in this chat; switch to propose.' },
    ]);
    const res = await ask({ message: 'Stop the blog', projectId, mode: 'ask' });
    expect(res.statusCode).toBe(200);
    const request = model.seen.at(-2);
    expect(request?.tools.map((tool) => tool.name)).not.toContain('project_stop');
    expect(res.json<AskBody>().proposals).toHaveLength(0);
    const stored = await t.database.db.select().from(aiMessages);
    expect(stored.some((row) => row.text.includes('not available in this session'))).toBe(true);
  });

  it('taints the session when it reads logs, and stays in propose from then on', async () => {
    model.script([
      { text: 'Reading the logs.', toolCalls: [{ name: 'project_logs', input: { projectId } }] },
      { text: 'The container is restarting because the port is wrong.' },
    ]);
    const first = await ask({ message: 'Why is the blog down?', projectId, mode: 'autopilot' });
    const { sessionId, tainted } = first.json<AskBody>();
    expect(tainted).toBe(true);

    model.script([
      {
        text: 'Restarting it is the smallest fix.',
        toolCalls: [{ name: 'project_restart', input: { projectId } }],
      },
      { text: 'Approve the restart and I will run it.' },
    ]);
    const second = await ask({ message: 'Fix it', projectId, sessionId, mode: 'autopilot' });
    const body = second.json<AskBody>();
    // Autopilot was asked for, but a session that read external content can only propose.
    expect(body.applied).toHaveLength(0);
    expect(body.proposals).toHaveLength(1);
    const [plan] = await t.database.db
      .select()
      .from(plans)
      .where(eq(plans.id, body.proposals[0]?.planId ?? ''));
    expect(plan?.reasons.join(' ')).toContain('external content');
  });

  it('stops before spending past the monthly cap, and says so in plain words', async () => {
    await setGrants({ guardrails: { ...DEFAULT_AI_GRANTS.guardrails, monthlySpendCapUsd: 0 } });
    const before = model.seen.length;
    model.script([{ text: 'should never be asked' }]);
    const res = await ask({ message: 'Anything at all', projectId });
    expect(res.statusCode).toBe(200);
    expect(res.json<AskBody>().text).toMatch(/spend cap of \$0/);
    expect(model.seen).toHaveLength(before);
    await setGrants({});
  });

  it('degrades gracefully when the model provider is unreachable', async () => {
    model.fail(new ModelUnavailable('The AI provider did not answer in time.', true));
    const res = await ask({ message: 'Why is the blog down?', projectId });
    expect(res.statusCode).toBe(200);
    expect(res.json<AskBody>().text).toContain('Everything else in VDeploy keeps working');
    model.script([{ text: 'back' }]);
  });

  it('is simply off, and says so, when the installation has no model', async () => {
    // Same database, no model: everything else on this installation still works.
    const plain = await buildServer({
      config: testConfig(t.database.url),
      db: t.database.db,
      authRateLimit: false,
      queue: { enqueue: () => Promise.resolve() },
      probe: () => Promise.resolve('filtered'),
    });
    try {
      const browser = new Browser(plain, 'Owner/1.0');
      await browser.request('POST', '/api/auth/sign-in/email', {
        email: 'owner@example.com',
        password: PASSWORD,
      });
      await browser.request('POST', '/api/auth/organization/set-active', { organizationId: orgId });
      const res = await browser.request('POST', '/api/v1/ai/ask', { message: 'hello' });
      expect(res.statusCode).toBe(503);
      expect(res.json<{ error: { message: string } }>().error.message).toContain(
        'assistant is off',
      );
      expect((await browser.request('GET', '/healthz')).statusCode).toBe(200);
    } finally {
      await plain.close();
    }
  });

  it('shows what it may do and what it cost, and narrows what it reads when told to', async () => {
    const shown = await op('ai.settings', {});
    expect(shown.statusCode).toBe(200);
    const settings = shown.json<{
      result: { available: boolean; model: string; grants: { read: Record<string, boolean> } };
    }>().result;
    expect(settings.available).toBe(true);
    expect(settings.model).toBe('claude-opus-5');
    expect(settings.grants.read.logs).toBe(true);

    const narrowed = { ...DEFAULT_AI_GRANTS, read: { ...DEFAULT_AI_GRANTS.read, logs: false } };
    // Widening or narrowing what the AI may do asks for the password again.
    expect((await op('ai.configure', { grants: narrowed })).statusCode).toBe(403);
    await stepUp();
    expect((await op('ai.configure', { grants: narrowed })).statusCode).toBe(200);

    model.script([{ text: 'I cannot see the logs here.' }]);
    await ask({ message: 'Why is the blog down?', projectId });
    const tools = model.seen.at(-1)?.tools.map((tool) => tool.name) ?? [];
    expect(tools).not.toContain('project_logs');
    // Tier 4 is never in any tool array: the AI cannot reach its own settings.
    expect(tools).not.toContain('ai_configure');
    expect(tools).not.toContain('ai_stop');
    await stepUp();
    expect((await op('ai.configure', { grants: DEFAULT_AI_GRANTS })).statusCode).toBe(200);
  });

  it('turns the AI off in one click, with no password and no waiting', async () => {
    const stopped = await op('ai.stop', {});
    expect(stopped.statusCode).toBe(200);
    const refused = await ask({ message: 'Are you there?', projectId });
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: { message: string } }>().error.message).toContain('turned off');
    await stepUp();
    expect((await op('ai.configure', { grants: DEFAULT_AI_GRANTS })).statusCode).toBe(200);
    model.script([{ text: 'Here again.' }]);
    expect((await ask({ message: 'Are you there?', projectId })).statusCode).toBe(200);
  });

  it('keeps every turn of the conversation, in order', async () => {
    const [session] = await t.database.db.select().from(aiSessions);
    const stored = await t.database.db
      .select()
      .from(aiMessages)
      .where(eq(aiMessages.sessionId, session?.id ?? ''));
    expect(stored.map((row) => row.role)[0]).toBe('user');
    expect(stored.map((row) => row.seq)).toEqual(stored.map((_, index) => index + 1));
  });
});
