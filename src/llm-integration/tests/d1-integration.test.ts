import assert from 'node:assert/strict';
import test from 'node:test';
import { D1ConversationStore } from '../conversations/d1-store.js';
import { createServices } from '../../runtime/factory.js';
import { localD1, TEST_NOW, TEST_SLOT, bookingContext } from './fixtures.js';

test('real local D1 persists contact, consent, checkpoints, recent history and turn replay', async () => {
  const { db, dispose } = await localD1();
  try {
    const store = new D1ConversationStore(db);
    const identity = { channel: 'instagram' as const, businessAccountId: 'gym', senderId: 'tester' };
    await store.withConversation(identity, async (session) => {
      session.state.customer.name = 'Test Prospect';
      session.state.customer.whatsappPhone = '+12145550101';
      session.state.customer.instagramHandle = '@test.prospect';
      session.state.customer.whatsappConsent = {
        phone: '+12145550101', purpose: 'trial_confirmation_and_reminders', grantedAt: TEST_NOW,
        sourceIdentity: identity, sourceMessageId: 'confirm', revokedAt: null,
      };
      session.state.bookingOperation = { action: 'book', startsAt: TEST_SLOT, context: bookingContext(session.state.customer.id, 'stable-key') };
      await session.save(session.state);
    });
    await store.withConversation(identity, async (session) => {
      assert.equal(session.state.bookingOperation?.context.operationKey, 'stable-key');
      assert.equal(session.state.customer.instagramHandle, '@test.prospect');
      assert.equal(session.state.customer.whatsappConsent?.sourceMessageId, 'confirm');
      for (let index = 0; index < 12; index++) {
        const message = { identity, providerMessageId: `message-${index}`, text: `user-${index}`, sentAt: TEST_NOW, receivedAt: TEST_NOW };
        await session.complete(message, session.state, { reply: `reply-${index}`, bookingStatus: 'none', usage: { inputTokens: 1, outputTokens: 1 } });
      }
    });
    await store.withConversation(identity, async (session) => {
      assert.equal(session.state.history.length, 20);
      assert.equal(session.state.history[0]?.content, 'user-2');
      assert.equal(session.state.history.at(-1)?.content, 'reply-11');
      assert.equal((await session.getProcessedTurn('message-11'))?.reply, 'reply-11');
    });
    const services = createServices({ DB: db, META_APP_SECRET: 'test', META_VERIFY_TOKEN: 'test' });
    assert.ok(services.statusHandler);
    assert.throws(() => services.processor, /OPENAI_API_KEY/);
  } finally { await dispose(); }
});
