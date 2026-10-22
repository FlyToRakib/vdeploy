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
 * It submits to the native `POST /v1/completions` — the prompt is
 * VDeploy's own flattening, and the channel can be chosen — and then polls
 * the job rather than holding the request open with `wait: true`: Revoye
 * may hold one for ten minutes, but the proxy in front of it closes the
 * connection at about two (a 524, seen live), and a closed connection
 * would leave the job running with nobody to collect it.
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

/** How long a job may take, past Revoye's own ten-minute hold. */
const WAIT_MS = 660_000;
/** Between looks at a running job: 40 a minute, well inside 1 200 reads a minute per key. */
const POLL_MS = 1_500;
const SETTLED = new Set(['succeeded', 'failed', 'cancelled', 'expired']);

/*
 * "Plain text, no code block" is not style: Revoye reads some answers out
 * of a chat interface, and a fenced block comes back as its label alone —
 * a tool call arrived as the single word "JSON" until this said so.
 */
const PROTOCOL = `You can call tools. To call one or more, reply with ONLY this JSON and nothing else:
{"tool_calls":[{"name":"<tool name>","input":{<arguments matching its input_schema>}}]}
Write it as plain text on one line: never in a code block, never with backticks or markdown.
Never say you will check or do something: call the tool for it in this reply.
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

/** The balanced `{…}` that starts at `start`, minding strings; null if it never closes. */
function objectAt(text: string, start: number): string | null {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * The tool calls in an answer.
 *
 * The protocol's object is found wherever it is — models put a sentence
 * before it, or a fence around it, however they are asked. A call to a
 * tool that was not offered, or with arguments that are not an object, is
 * dropped — the same rule the OpenAI adapter applies to malformed
 * arguments.
 */
function readCalls(text: string, offered: Set<string>): ToolCall[] {
  const start = text.search(/\{\s*"tool_calls"/);
  const body = start < 0 ? null : objectAt(text, start);
  if (!body) return [];
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

interface Job {
  id?: string;
  status?: string;
  response?: string | null;
  error?: RevoyeError;
}

export function revoyeModel(options: RevoyeOptions): ModelClient {
  const call = options.fetch ?? fetch;
  const url = (options.baseUrl ?? 'https://api.revoye.com').replace(/\/+$/, '') + '/v1/completions';
  const model = options.model ?? 'revoye/auto';
  const pinned = model === 'revoye/auto' ? null : model.replace(/^revoye\//, '');
  const auth = { authorization: `Bearer ${options.apiKey}` };

  /** One request; a job back, or why not. */
  async function send(target: string, init: RequestInit): Promise<Job> {
    let response: Response;
    try {
      response = await call(target, init);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ModelUnavailable(
        `VDeploy could not reach Revoye: ${error instanceof Error ? error.message : 'no answer'}`,
        true,
      );
    }
    const body = (await response.json().catch(() => null)) as Job | null;
    if (!response.ok) throw explain(response.status, body?.error);
    return body ?? {};
  }

  return {
    model,
    reply: async (request, signal) => {
      const timeout = AbortSignal.timeout(WAIT_MS);
      const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let job: Job = {};
      try {
        job = await send(url, {
          method: 'POST',
          headers: {
            ...auth,
            'content-type': 'application/json',
            'idempotency-key': crypto.randomUUID(),
          },
          body: JSON.stringify({
            prompt: toPrompt(request),
            channel: options.channel ?? 'auto',
            provider: pinned,
            wait: false,
          }),
          signal: stop,
        });
        while (!SETTLED.has(job.status ?? '')) {
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          stop.throwIfAborted();
          job = await send(`${url}/${encodeURIComponent(job.id ?? '')}`, {
            headers: auth,
            signal: stop,
          });
        }
      } catch (error) {
        if (!stop.aborted) throw error;
        // Not waiting is not cancelling: stop the job, or it runs on and is charged.
        if (job.id) {
          void call(`${url}/${encodeURIComponent(job.id)}`, {
            method: 'DELETE',
            headers: auth,
          }).catch(() => undefined);
        }
        throw new ModelUnavailable('Revoye took longer than ten minutes to answer.', false);
      }
      if (job.status !== 'succeeded') {
        throw new ModelUnavailable(
          `Revoye could not answer this one (${job.status ?? 'unknown'}).`,
          job.status === 'expired',
        );
      }

      const text = job.response ?? '';
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
