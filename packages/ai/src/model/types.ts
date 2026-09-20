import type { ToolDefinition } from '../policy/tools.js';

/** One turn of a conversation, as the platform stores it. */
export type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; callId: string; result: string; isError?: boolean };

export interface ToolCall {
  id: string;
  /** The model-facing name (`project_restart`), not the operation name. */
  name: string;
  input: Record<string, unknown>;
}

export interface ModelRequest {
  /** The cached prefix: platform concepts and how to answer. */
  system: string;
  /** Volatile context for this turn; it goes after the cache breakpoint. */
  context: string;
  messages: Turn[];
  tools: ToolDefinition[];
  maxTokens?: number;
  /** How hard to think: lower is cheaper and faster. */
  effort?: 'low' | 'medium' | 'high';
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ModelReply {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  /** Why the model stopped; `refusal` means it declined, with a reason. */
  stop: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';
  refusal: string | null;
  /** The model that answered, as it named itself. */
  model: string;
  costUsd: number;
}

/**
 * What the platform needs from a model provider. Anything that can answer
 * this can drive the assistant: the tests use a scripted one, and the
 * platform works with no model at all (§26 AI-degradation fallback).
 */
export interface ModelClient {
  readonly model: string;
  reply: (request: ModelRequest, signal?: AbortSignal) => Promise<ModelReply>;
}

/** Raised when the provider refuses the key, is out of quota, or is down. */
export class ModelUnavailable extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ModelUnavailable';
  }
}
