import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../../index.js';
import { handleQueue } from '../runtime/queue.js';
import { canProcessMessages } from '../runtime/test-access.js';

test('thin entrypoint preserves the Meta challenge endpoint', async () => {
  const response = await worker.fetch(
    new Request('https://example.com/webhook?hub.mode=subscribe&hub.verify_token=test-token&hub.challenge=challenge-123'),
    { META_VERIFY_TOKEN: 'test-token', META_APP_SECRET: 'test-secret' },
    {} as ExecutionContext,
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'challenge-123');
});

test('messaging defaults to observation and test mode allows exact sender IDs only', () => {
  const env = { META_APP_SECRET: 'test', META_VERIFY_TOKEN: 'test' };
  const identity = { channel: 'instagram' as const, businessAccountId: 'gym', senderId: '1234' };
  assert.equal(canProcessMessages(identity, env), false);
  assert.equal(canProcessMessages(identity, { ...env, META_MESSAGING_MODE: 'test' }), false);
  assert.equal(canProcessMessages(identity, { ...env, META_MESSAGING_MODE: 'test', META_TEST_INSTAGRAM_SENDER_IDS: '123' }), false);
  assert.equal(canProcessMessages(identity, { ...env, META_MESSAGING_MODE: 'test', META_TEST_INSTAGRAM_SENDER_IDS: '1234, 5678' }), true);
  assert.equal(canProcessMessages({ ...identity, channel: 'whatsapp' }, { ...env, META_MESSAGING_MODE: 'test', META_TEST_INSTAGRAM_SENDER_IDS: '1234' }), false);
});

test('unconfigured queue cannot silently acknowledge messages', async () => {
  await assert.rejects(handleQueue({} as MessageBatch<unknown>, { META_APP_SECRET: 'test', META_VERIFY_TOKEN: 'test' }), /DB is required/);
});

test('observe mode does not run model or sends when queue wakes up', async () => {
  let acked = 0;
  const batch = { ackAll() { acked++; } } as unknown as MessageBatch<unknown>;
  await handleQueue(batch, { META_APP_SECRET: 'test', META_VERIFY_TOKEN: 'test', DB: {} as D1Database });
  assert.equal(acked, 1);
});
