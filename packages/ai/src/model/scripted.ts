import { costOf } from './cost.js';
import type { ModelClient, ModelReply, ModelRequest } from './types.js';

/**
 * A model that answers from a script. Tests use it, and so does an
 * installation that wants the assistant's shape without a provider — the
 * platform is fully usable with no model at all (§26).
 */
export interface ScriptedReply {
  text?: string;
  toolCalls?: { name: string; input: Record<string, unknown> }[];
  stop?: ModelReply['stop'];
  refusal?: string;
}

export function scriptedModel(
  replies: ScriptedReply[],
  model = 'scripted',
): ModelClient & { seen: ModelRequest[] } {
  const seen: ModelRequest[] = [];
  let turn = 0;
  return {
    model,
    seen,
    reply: (request) => {
      seen.push(request);
      const next = replies[Math.min(turn, replies.length - 1)] ?? {};
      turn += 1;
      const usage = {
        inputTokens: Math.ceil((request.system.length + request.context.length) / 4),
        outputTokens: Math.ceil((next.text ?? '').length / 4),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      return Promise.resolve({
        text: next.text ?? '',
        toolCalls: (next.toolCalls ?? []).map((call, index) => ({
          id: `call_${String(turn)}_${String(index)}`,
          name: call.name,
          input: call.input,
        })),
        usage,
        stop: next.stop ?? (next.toolCalls?.length ? 'tool_use' : 'end_turn'),
        refusal: next.refusal ?? null,
        model,
        costUsd: costOf(model, usage),
      });
    },
  };
}
