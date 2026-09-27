import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../../index.js';
import { createQueueHandler, handleQueue } from '../runtime/queue.js';

test('thin entrypoint preserves the Meta challenge endpoint', async () => {
  const response = await worker.fetch(
    new Request('https://example.com/webhook?hub.mode=subscribe&hub.verify_token=test-token&hub.challenge=challenge-123'),
    { META_VERIFY_TOKEN: 'test-token', META_APP_SECRET: 'test-secret' },
    {} as ExecutionContext,
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'challenge-123');
});

test('unconfigured queue cannot silently acknowledge messages', async () => {
  await assert.rejects(handleQueue({} as MessageBatch<unknown>), /not configured/);
});

test('queue acknowledges durable completion and retries processor failures', async () => {
  let acked = 0;
  let retried = 0;
  const body = {
    identity: { channel: 'instagram', businessAccountId: 'gym', senderId: 'prospect' },
    providerMessageId: 'incoming', sentAt: '2026-09-27T18:00:00Z', receivedAt: '2026-09-27T18:00:00Z', text: 'hola',
  };
  const batch = { messages: [{ id: 'queue-1', body, ack() { acked++; }, retry() { retried++; } }] } as unknown as MessageBatch<unknown>;
  await createQueueHandler(async () => ({ reply: 'hola', bookingStatus: 'none', usage: { inputTokens: 1, outputTokens: 1 } }))(batch);
  assert.equal(acked, 1);
  await createQueueHandler(async () => { throw new Error('storage failed'); })(batch);
  assert.equal(acked, 1);
  assert.equal(retried, 1);
});
