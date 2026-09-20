import Anthropic from '@anthropic-ai/sdk';
import { costOf, DEFAULT_MODEL } from './cost.js';
import {
  ModelUnavailable,
  type ModelClient,
  type ModelReply,
  type ModelRequest,
  type ToolCall,
} from './types.js';

/**
 * The Anthropic adapter (§26 "Anthropic adapter (BYOK)"). The key belongs to
 * the organization, not to VDeploy: it is stored encrypted and passed in.
 *
 * The cached prefix (tools, then the system prompt) is marked for caching and
 * never changes within a session; everything volatile — this turn's context —
 * goes after it, in the first user message.
 */
export interface AnthropicOptions {
  apiKey: string;
  model?: string;
  /** Replaced in tests; the SDK uses the platform's fetch otherwise. */
  fetch?: typeof fetch;
  baseURL?: string;
}

const MAX_TOKENS = 4096;

/** Tool results from the platform go back as one user message, as the API expects. */
function toMessages(request: ModelRequest): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  let pendingResults: Anthropic.ToolResultBlockParam[] = [];
  const flush = () => {
    if (pendingResults.length === 0) return;
    messages.push({ role: 'user', content: pendingResults });
    pendingResults = [];
  };

  for (const [index, turn] of request.messages.entries()) {
    if (turn.role === 'tool') {
      pendingResults.push({
        type: 'tool_result',
        tool_use_id: turn.callId,
        content: turn.result,
        ...(turn.isError ? { is_error: true } : {}),
      });
      continue;
    }
    flush();
    if (turn.role === 'user') {
      // The volatile context rides with the first thing the person said.
      const text = index === 0 ? `${request.context}\n\n---\n\n${turn.text}` : turn.text;
      messages.push({ role: 'user', content: text });
      continue;
    }
    const content: Anthropic.ContentBlockParam[] = [];
    if (turn.text) content.push({ type: 'text', text: turn.text });
    for (const call of turn.toolCalls ?? []) {
      content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
    }
    if (content.length > 0) messages.push({ role: 'assistant', content });
  }
  flush();
  return messages;
}

function readReply(message: Anthropic.Message, model: string): ModelReply {
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  const toolCalls: ToolCall[] = message.content
    .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
    .map((block) => ({
      id: block.id,
      name: block.name,
      input: (block.input ?? {}) as Record<string, unknown>,
    }));
  const usage = {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
  };
  const stop =
    message.stop_reason === 'tool_use' ||
    message.stop_reason === 'max_tokens' ||
    message.stop_reason === 'refusal'
      ? message.stop_reason
      : 'end_turn';
  return {
    text,
    toolCalls,
    usage,
    stop,
    refusal:
      stop === 'refusal' ? (message.stop_details?.explanation ?? 'The model declined.') : null,
    model: message.model,
    costUsd: costOf(model, usage),
  };
}

/** What went wrong, in words the person who set up the key can act on. */
function explain(error: unknown): ModelUnavailable {
  if (error instanceof Anthropic.AuthenticationError) {
    return new ModelUnavailable(
      'The Anthropic API key was refused. Check the key in Settings → AI.',
      false,
    );
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new ModelUnavailable('That API key may not use this model.', false);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ModelUnavailable('Anthropic is rate-limiting this key; try again shortly.', true);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ModelUnavailable('VDeploy could not reach Anthropic; try again shortly.', true);
  }
  if (error instanceof Anthropic.APIError) {
    const retryable = (error.status ?? 500) >= 500;
    return new ModelUnavailable(
      `Anthropic answered ${String(error.status ?? '')}: ${error.message}`,
      retryable,
    );
  }
  return new ModelUnavailable(
    error instanceof Error ? error.message : 'The model could not be reached.',
    true,
  );
}

export function anthropicModel(options: AnthropicOptions): ModelClient {
  const model = options.model ?? DEFAULT_MODEL;
  const client = new Anthropic({
    apiKey: options.apiKey,
    maxRetries: 2,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  });

  return {
    model,
    reply: async (request, signal) => {
      try {
        const message = await client.messages.create(
          {
            model,
            max_tokens: request.maxTokens ?? MAX_TOKENS,
            thinking: { type: 'adaptive' },
            output_config: { effort: request.effort ?? 'medium' },
            // Tools render before the system prompt; one breakpoint caches both.
            system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
            })),
            messages: toMessages(request),
          },
          signal ? { signal } : {},
        );
        return readReply(message, model);
      } catch (error) {
        throw explain(error);
      }
    },
  };
}
