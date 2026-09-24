import {
  bindTools,
  buildContext,
  checkSpend,
  estimateCost,
  ModelUnavailable,
  systemPrompt,
  taintsSession,
  toolName,
  type AiActor,
  type AiMode,
  type HumanActor,
  type Turn,
} from '@vdeploy/ai';
import { findOperation, newId, OPERATIONS, VDeployError, type Id } from '@vdeploy/contracts';
import {
  aiSession,
  aiSpendThisMonth,
  aiTurns,
  appendAiTurns,
  gatherContext,
  recordProposal,
  startAiSession,
  updateAiSession,
} from '@vdeploy/db';
import type { KernelDeps } from '../kernel/context.js';
import { loadGrants, runOperation } from '../kernel/pipeline.js';

/** How many times the model may call tools before a turn has to end. */
const MAX_STEPS = 6;
/** How much of a tool's answer the model sees; the rest is a summary it can ask about. */
const MAX_TOOL_RESULT = 6000;

export interface AskInput {
  sessionId?: string;
  message: string;
  /** The project the person is looking at, if any. */
  projectId?: string;
  mode?: AiMode;
}

export interface ProposalMade {
  id: string;
  planId: string;
  title: string;
  operation: string;
}

export interface AskResult {
  sessionId: string;
  text: string;
  proposals: ProposalMade[];
  /** What was actually run (autopilot), for the person to see. */
  applied: { operation: string; planId: string | null }[];
  tainted: boolean;
  costUsd: number;
}

const byToolName = new Map(OPERATIONS.map((op) => [toolName(op), op]));

function summarise(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= MAX_TOOL_RESULT) return text;
  return `${text.slice(0, MAX_TOOL_RESULT)}\n… cut; ask for a narrower part if you need more.`;
}

/** The first line the model wrote, which is what the proposal card shows. */
function headline(text: string): string | null {
  const first = text.split('\n')[0]?.trim();
  return first ? first.slice(0, 120) : null;
}

/** A line for the proposal card when the model said nothing useful this turn. */
function fallbackTitle(operation: string): string {
  return `${operation.replace(/[._]/g, ' ')} — proposed by the assistant`;
}

/**
 * One turn with the assistant (§9, §11). The model reads through the context
 * engine and acts only through tools, and every tool call goes through the
 * same gate as a click in the dashboard: in propose mode a change comes back
 * as a plan a person approves, in autopilot the gate decides whether it may
 * run now. Nothing here can widen what the person is allowed to do.
 */
export async function ask(
  deps: KernelDeps,
  human: HumanActor,
  input: AskInput,
): Promise<AskResult> {
  const model = deps.model;
  if (!model) {
    throw new VDeployError(
      'unavailable',
      'No AI model is set up on this VDeploy, so the assistant is off. Everything else works as usual.',
    );
  }
  const grants = await loadGrants(deps, human.orgId);
  if (!grants.enabled) {
    throw new VDeployError('policy_denied', 'The AI is turned off for this organization.');
  }

  const now = deps.now();
  const existing = input.sessionId
    ? await aiSession(deps.db, input.sessionId, human.orgId, human.userId)
    : null;
  if (input.sessionId && !existing) throw new VDeployError('not_found', 'That chat has ended.');
  const session =
    existing ??
    (await startAiSession(
      deps.db,
      {
        orgId: human.orgId,
        userId: human.userId,
        mode: input.mode ?? 'propose',
        model: model.model,
        focusProjectId: input.projectId ?? null,
      },
      now,
    ));
  // A tainted session can never be in autopilot (§8 L4).
  const mode: AiMode = session.tainted ? 'propose' : (input.mode ?? session.mode);
  const focusProjectId = input.projectId ?? session.focusProjectId;

  const actor: AiActor = {
    kind: 'ai',
    userId: human.userId,
    orgId: human.orgId,
    role: human.role,
    origin: 'ai',
    aiSessionId: session.id as Id<'aiSession'>,
    model: model.model,
    mode,
    tainted: session.tainted,
  };

  const context = buildContext(await gatherContext(deps.db, human.orgId, focusProjectId));
  const system = systemPrompt(mode);
  const tools = bindTools(actor, grants);
  const messages: Turn[] = [...(await aiTurns(deps.db, session.id))];
  const fresh: Turn[] = [{ role: 'user', text: input.message }];
  messages.push(...fresh);

  const proposals: ProposalMade[] = [];
  const applied: { operation: string; planId: string | null }[] = [];
  let costUsd = 0;
  let tainted = session.tainted;
  let answer = '';

  for (let step = 0; step < MAX_STEPS; step++) {
    const spent = await aiSpendThisMonth(deps.db, human.orgId, now);
    const estimate = estimateCost(
      model.model,
      context.usage.reduce((n, u) => n + u.tokens, 2000),
      4000,
    );
    const denied = checkSpend(grants, spent + costUsd, estimate);
    if (denied) {
      answer = `${denied.reason}. Raise it in Settings → AI, or wait for next month.`;
      break;
    }

    let reply;
    try {
      reply = await model.reply({ system, context: context.text, messages, tools });
    } catch (error) {
      if (error instanceof ModelUnavailable) {
        answer = `${error.message} Everything else in VDeploy keeps working.`;
        break;
      }
      throw error;
    }
    costUsd += reply.costUsd;
    answer = reply.refusal ?? reply.text;
    const assistantTurn: Turn = {
      role: 'assistant',
      text: reply.text,
      ...(reply.toolCalls.length ? { toolCalls: reply.toolCalls } : {}),
    };
    messages.push(assistantTurn);
    fresh.push(assistantTurn);
    if (reply.toolCalls.length === 0) break;

    for (const call of reply.toolCalls) {
      const op = byToolName.get(call.name);
      const outcome = await callTool(deps, actor, op?.name ?? call.name, call.input);
      if (op && taintsSession(op) && !tainted) {
        tainted = true;
        actor.tainted = true;
      }
      if (outcome.proposal) {
        const id = await recordProposal(
          deps.db,
          {
            orgId: human.orgId,
            sessionId: session.id,
            planId: outcome.proposal.planId,
            title: headline(reply.text) ?? fallbackTitle(op?.name ?? call.name),
            plain: reply.text || 'The assistant proposed this change.',
          },
          now,
        );
        proposals.push({
          id,
          planId: outcome.proposal.planId,
          title: outcome.proposal.title,
          operation: op?.name ?? call.name,
        });
      }
      if (outcome.applied)
        applied.push({ operation: op?.name ?? call.name, planId: outcome.planId });
      const turn: Turn = {
        role: 'tool',
        callId: call.id,
        result: outcome.result,
        ...(outcome.isError ? { isError: true } : {}),
      };
      messages.push(turn);
      fresh.push(turn);
    }
  }

  await appendAiTurns(deps.db, session.id, fresh, now);
  await updateAiSession(
    deps.db,
    session.id,
    { addSpendUsd: costUsd, tainted, focusProjectId: focusProjectId ?? null },
    now,
  );
  return { sessionId: session.id, text: answer, proposals, applied, tainted, costUsd };
}

interface ToolOutcome {
  result: string;
  isError?: boolean;
  applied?: boolean;
  planId: string | null;
  proposal?: { planId: string; title: string };
}

/** Runs one tool call through the pipeline and says what the model should read. */
async function callTool(
  deps: KernelDeps,
  actor: AiActor,
  operation: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  const known = findOperation(operation);
  if (!known) {
    return { result: `There is no tool called ${operation}.`, isError: true, planId: null };
  }
  try {
    const response = await runOperation(deps, actor, operation, {
      input,
      idempotencyKey: newId('aiSession').slice(0, 40),
    });
    if (response.status === 'done') {
      return { result: summarise(response.result), planId: null };
    }
    const plan = response.plan;
    if (response.status === 'pending_approval') {
      return {
        result: `Prepared, and waiting for the person to approve it: ${plan.reasons.join(' ')} Tell them what it does and what it risks.`,
        planId: plan.id,
        proposal: { planId: plan.id, title: operation },
      };
    }
    return { result: `Done: ${operation} is running now.`, applied: true, planId: plan.id };
  } catch (error) {
    if (error instanceof VDeployError) {
      // A refusal is information for the model, not a crash: it should explain or try another way.
      return { result: `Refused: ${error.message}`, isError: true, planId: null };
    }
    throw error;
  }
}
