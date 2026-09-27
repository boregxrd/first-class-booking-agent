import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAIModelClient, ModelRequestError } from '../agent/client.js';

test('client sends model, tools, history and parses token usage', async () => {
  const client = new OpenAIModelClient({ apiKey: 'test-key', fetch: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(init!.body as string);
    assert.equal(body.model, 'gpt-4.1-mini');
    assert.equal(body.store, false);
    assert.equal(body.parallel_tool_calls, false);
    assert.equal(body.messages[0].content, 'hola');
    assert.ok(init!.signal);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '¡Hola! 💖' } }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
  } });
  const reply = await client.complete([{ role: 'user', content: 'hola' }], []);
  assert.equal(reply.message.content, '¡Hola! 💖');
  assert.deepEqual(reply.usage, { inputTokens: 100, outputTokens: 10 });
});

test('provider errors are classified without leaking bodies', async () => {
  const client = new OpenAIModelClient({ apiKey: 'test-key', fetch: async () => new Response('sensitive error body', { status: 429 }) });
  await assert.rejects(client.complete([], []), (error) => {
    assert.ok(error instanceof ModelRequestError);
    assert.ok(error.retryable);
    assert.equal(error.status, 429);
    assert.doesNotMatch(error.message, /sensitive/);
    return true;
  });
});

test('truncated responses cannot execute tools', async () => {
  const client = new OpenAIModelClient({ apiKey: 'test-key', fetch: async () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null } }],
    usage: { prompt_tokens: 100, completion_tokens: 600 },
  })) });
  await assert.rejects(client.complete([], []));
});
