import {
  ModelUnavailable,
  type ModelClient,
  type ModelReply,
  type ModelRequest,
  type ToolCall,
} from './types.js';

/**
 * The Revoye adapter (§22 "providers are thin adapters").
 *
 * Revoye is an AI router with one HTTP API: a prompt goes in, the complete
 * answer comes out 3 to 90 seconds later, processed on Revoye Cloud or on
 * the account owner's own machine (Revoye Desk). Two things set it apart
 * from the OpenAI shape, and they are why this is not just a base URL for
 * that adapter:
 *
 * - **It has no tool calling.** Its chat endpoint flattens messages to text
 *   and has no `tool` role. So the tools are described in the prompt and a
 *   call comes back as a JSON object, which is read here. That is safe for
 *   the same reason any model's tool call is: what a model asks for is only
 *   ever a request — the policy engine and the schema decide (N3), and a
 *   name that was not offered is dropped before anything sees it.
 * - **It reports no tokens.** `usage` is always null, so a turn costs
 *   nothing on VDeploy's meter; the plan's allowance is Revoye's to count.
 *
 * It uses the native `POST /v1/completions` with `wait: true`: the prompt
 * is VDeploy's own flattening, and the channel can be chosen.
 */

export interface RevoyeOptions {
  apiKey: string;
  /** `https://api.revoye.com` unless the operator points elsewhere. */
  baseUrl?: string;
  /** `revoye/auto` lets Revoye choose; any other id from `GET /v1/models` pins one. */
  model?: string;
  /** Where it runs: `auto` (the plan's channels, with fallback), `cloud` or `desk`. */
  channel?: 'auto' | 'cloud' | 'desk';
  /** Replaced in tests; the platform's own otherwise. */
  fetch?: typeof fetch;
}

/** Revoye holds a waiting request for up to ten minutes; a shorter client gives up on a healthy job. */
const WAIT_MS = 660_000;

const PROTOCOL = `You can call tools. To call one or more, reply with ONLY this JSON and nothing else:
{"tool_calls":[{"name":"<tool name>","input":{<arguments matching its input_schema>}}]}
Each result comes back as a "Tool result" turn. When you need no tool, answer in plain words.
Tools:`;

/** Revoye's ceiling on one request text. */
const MAX_PROMPT = 100_000;

/**
 * Bounds a schema can state that the model need not read: the platform
 * checks every call against the full schema (L6) and a miss comes back as
 * a tool result. Leaving them out halves the full tool array (~104k → ~57k
 * characters), which is what lets an owner's array fit under the ceiling.
 */
const BOUNDS = new Set([
  '$schema',
  'additionalProperties',
  'pattern',
  'format',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'propertyNames',
  'default',
]);

function lean(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(lean);
  if (typeof schema !== 'object' || schema === null) return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !BOUNDS.has(key))
      .map(([key, value]) => [key, lean(value)]),
  );
}

/**
 * The whole conversation as one request text: Revoye is not a stateful
 * chat API. When it would not fit, the oldest turns go first — the system
 * prompt, the tools, what is true now and the latest question never do.
 */
function toPrompt(request: ModelRequest): string {
  const head = [request.system];
  if (request.tools.length > 0) {
    const tools = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: lean(t.inputSchema),
    }));
    head.push(`${PROTOCOL}\n${JSON.stringify(tools)}`);
  }
  head.push(`---\n\n${request.context}`);
  const turns = request.messages.map((turn) => {
    if (turn.role === 'user') return `User: ${turn.text}`;
    if (turn.role === 'tool')
      return `Tool result (${turn.callId}${turn.isError ? ', failed' : ''}): ${turn.result}`;
    const calls = turn.toolCalls?.map(({ name, input }) => ({ name, input })) ?? [];
    return `Assistant: ${calls.length ? JSON.stringify({ tool_calls: calls }) : turn.text}`;
  });
  const build = () => [...head, ...turns, 'Assistant:'].join('\n\n');
  let prompt = build();
  if (prompt.length > MAX_PROMPT) {
    head.push('(Earlier turns of this conversation were left out.)');
    while (prompt.length > MAX_PROMPT && turns.length > 1) {
      turns.shift();
      prompt = build();
    }
  }
  return prompt;
}

/**
 * The tool calls in an answer, if the whole answer is one.
 *
 * A fenced block is unwrapped, since models add one unasked. Anything that
 * is not exactly the protocol's object is prose, and a call to a tool that
 * was not offered, or with arguments that are not an object, is dropped —
 * the same rule the OpenAI adapter applies to malformed arguments.
 */
function readCalls(text: string, offered: Set<string>): ToolCall[] {
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*|\s*```$/g, '')
    .trim();
  if (!body.startsWith('{') || !body.includes('"tool_calls"')) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const calls = (parsed as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(calls)) return [];
  const out: ToolCall[] = [];
  for (const call of calls as { name?: unknown; input?: unknown }[]) {
    const { name, input } = call;
    if (typeof name !== 'string' || !offered.has(name)) continue;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) continue;
    out.push({ id: `call_${crypto.randomUUID()}`, name, input: input as Record<string, unknown> });
  }
  return out;
}

interface RevoyeError {
  code?: string;
  message?: string;
  details?: { resets_at?: string; job_id?: string };
}

/**
 * What went wrong, branched on `code` — Revoye's contract; its message is
 * for humans and may change — in words the operator can act on.
 */
function explain(status: number, error: RevoyeError | undefined): ModelUnavailable {
  switch (error?.code) {
    case 'UNAUTHORIZED':
    case 'FORBIDDEN':
      return new ModelUnavailable('Revoye refused the API key. Check REVOYE_API_KEY.', false);
    case 'SUBSCRIPTION_INACTIVE':
      return new ModelUnavailable('The Revoye account has no active plan.', false);
    case 'CHANNEL_NOT_ENTITLED':
      return new ModelUnavailable('The Revoye plan does not include that channel.', false);
    case 'QUOTA_EXCEEDED':
      return new ModelUnavailable(
        `This month's Revoye allowance is used up${error.details?.resets_at ? ` until ${error.details.resets_at}` : ''}.`,
        false,
      );
    case 'RATE_LIMITED':
    case 'NO_AGENT_AVAILABLE':
    case 'NO_DEVICE_ONLINE':
    case 'PROVIDER_RATE_LIMITED':
    case 'INTERNAL_ERROR':
      return new ModelUnavailable(
        'Revoye has no capacity free right now; try again shortly.',
        true,
      );
    case 'JOB_TIMEOUT':
      // The job is still running at Revoye; sending it again would run it twice.
      return new ModelUnavailable('Revoye took longer than ten minutes to answer.', false);
    default:
      return new ModelUnavailable(
        `Revoye answered ${String(status)}${error?.code ? ` (${error.code})` : ''}.`,
        status >= 500,
      );
  }
}

export function revoyeModel(options: RevoyeOptions): ModelClient {
  const call = options.fetch ?? fetch;
  const url = (options.baseUrl ?? 'https://api.revoye.com').replace(/\/+$/, '') + '/v1/completions';
  const model = options.model ?? 'revoye/auto';
  const pinned = model === 'revoye/auto' ? null : model.replace(/^revoye\//, '');

  return {
    model,
    reply: async (request, signal) => {
      const timeout = AbortSignal.timeout(WAIT_MS);
      let response: Response;
      try {
        response = await call(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
            'idempotency-key': crypto.randomUUID(),
          },
          body: JSON.stringify({
            prompt: toPrompt(request),
            channel: options.channel ?? 'auto',
            provider: pinned,
            wait: true,
          }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        throw new ModelUnavailable(
          `VDeploy could not reach Revoye: ${error instanceof Error ? error.message : 'no answer'}`,
          true,
        );
      }
      const body = (await response.json().catch(() => null)) as {
        status?: string;
        response?: string | null;
        error?: RevoyeError;
      } | null;
      if (!response.ok) throw explain(response.status, body?.error);
      // 202: past the account's 100 held requests, Revoye queues instead of waiting.
      if (body?.status !== 'succeeded') {
        throw new ModelUnavailable('Revoye is busy with other requests; try again shortly.', true);
      }

      const text = body.response ?? '';
      const toolCalls = readCalls(text, new Set(request.tools.map((t) => t.name)));
      return {
        text: toolCalls.length ? '' : text,
        toolCalls,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stop: toolCalls.length ? 'tool_use' : 'end_turn',
        refusal: null,
        model,
        costUsd: 0,
      } satisfies ModelReply;
    },
  };
}
