import { z } from 'zod';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ModelTool {
  type: 'function';
  function: { name: string; description: string; strict: true; parameters: Record<string, unknown> };
}

export interface ModelReply {
  message: Extract<ChatMessage, { role: 'assistant' }>;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ModelClient {
  complete(messages: ChatMessage[], tools: ModelTool[]): Promise<ModelReply>;
}

const responseSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.enum(['stop', 'tool_calls']),
    message: z.object({
      role: z.literal('assistant'),
      content: z.string().nullable(),
      refusal: z.string().nullish(),
      tool_calls: z.array(z.object({
        id: z.string().min(1),
        type: z.literal('function'),
        function: z.object({ name: z.string().min(1), arguments: z.string() }),
      })).max(4).optional(),
    }),
  })).length(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
  }),
});

export class ModelRequestError extends Error {
  constructor(public readonly status: number, public readonly retryable: boolean) {
    super(`Model request failed (HTTP ${status})`);
  }
}

/** Workers-native fetch client. Queue/turn recovery owns retries; no hidden retries. */
export class OpenAIModelClient implements ModelClient {
  constructor(private readonly options: {
    apiKey: string;
    model?: string;
    timeoutMs?: number;
    fetch?: typeof fetch;
  }) {
    if (!options.apiKey.trim()) throw new Error('OPENAI_API_KEY is required');
  }

  async complete(messages: ChatMessage[], tools: ModelTool[]): Promise<ModelReply> {
    const response = await (this.options.fetch ?? fetch)('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      body: JSON.stringify({
        model: this.options.model ?? 'gpt-4.1-mini',
        messages,
        tools,
        parallel_tool_calls: false,
        max_completion_tokens: 600,
        store: false,
      }),
    });
    if (!response.ok) {
      // Do not expose provider response bodies or credentials in logs/errors.
      throw new ModelRequestError(response.status, response.status === 429 || response.status >= 500);
    }
    const parsed = responseSchema.parse(await response.json());
    const { message, finish_reason } = parsed.choices[0]!;
    const calls = message.tool_calls ?? [];
    if (message.refusal || (!message.content?.trim() && calls.length === 0)
      || (finish_reason === 'tool_calls') !== (calls.length > 0)) {
      throw new Error('Model returned an unusable response');
    }
    return {
      message: { role: 'assistant', content: message.content, ...(calls.length ? { tool_calls: calls } : {}) },
      usage: { inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens },
    };
  }
}
