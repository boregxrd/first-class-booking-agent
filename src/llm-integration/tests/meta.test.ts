import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { processMetaWebhook } from '../../channels/meta.js';
import { MetaTextSender, MetaWhatsAppTemplateSender } from '../../channels/outbound.js';
import { localD1, seedCustomer } from './fixtures.js';
import type { Env } from '../../types/env.js';

const env: Env = { META_APP_SECRET: 'test-secret', META_VERIFY_TOKEN: 'test', META_MESSAGING_MODE: 'test', META_TEST_INSTAGRAM_SENDER_IDS: 'tester',
  META_INSTAGRAM_ACCOUNT_ID: 'gym', META_INSTAGRAM_ACCESS_TOKEN: 'ig-token', META_WHATSAPP_PHONE_NUMBER_ID: 'wa-gym', META_WHATSAPP_ACCESS_TOKEN: 'wa-token', META_GRAPH_API_VERSION: 'v23.0' };
const signature = (raw: string) => `sha256=${createHmac('sha256', env.META_APP_SECRET).update(raw).digest('hex')}`;

test('webhook validates malformed/signed payloads, ignores echoes and deduplicates before acknowledgement', async () => {
  const { db, dispose } = await localD1();
  try {
    for (const body of ['null', '{}', '{']) assert.equal((await processMetaWebhook(body, signature(body), env)).status, 400);
    assert.equal((await processMetaWebhook('{}', 'sha256=bad', env)).status, 401);
    const raw = JSON.stringify({ object: 'instagram', entry: [{ messaging: [
      { sender: { id: 'tester' }, recipient: { id: 'gym' }, timestamp: Date.now(), message: { mid: 'inbound', text: 'hola' } },
      { sender: { id: 'tester' }, recipient: { id: 'gym' }, timestamp: Date.now(), message: { mid: 'echo', text: 'hola', is_echo: true } },
      { sender: { id: 'someone-else' }, recipient: { id: 'gym' }, timestamp: Date.now(), message: { mid: 'ignored', text: 'hola' } },
    ] }] });
    assert.equal((await processMetaWebhook(raw, signature(raw), { ...env, DB: db })).status, 200);
    assert.equal((await processMetaWebhook(raw, signature(raw), { ...env, DB: db })).status, 200);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM message_inbox').first<{ n: number }>())?.n, 1);
    assert.equal((await processMetaWebhook(raw, signature(raw), env)).status, 503);
  } finally { await dispose(); }
});

test('Instagram Login endpoint, separate tokens, windows, expiry and uncertain results', async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; token: string | null }> = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), token: new Headers(options?.headers).get('Authorization') });
    return new Response(JSON.stringify(String(url).includes('instagram') ? { message_id: 'ig-1' } : { messages: [{ id: 'wa-1' }] }));
  };
  try {
    const now = new Date().toISOString();
    const ig = { channel: 'instagram' as const, businessAccountId: 'gym', senderId: 'tester' };
    const sender = new MetaTextSender(env);
    assert.equal((await sender.sendText(ig, 'hello', now, now)).status, 'accepted');
    assert.equal(calls[0]!.url, 'https://graph.instagram.com/v23.0/gym/messages');
    assert.equal(calls[0]!.token, 'Bearer ig-token');
    assert.equal((await sender.sendText(ig, 'hello', '2000-01-01T00:00:00Z', now)).status, 'rejected');
    assert.equal((await new MetaTextSender({ ...env, META_INSTAGRAM_TOKEN_EXPIRES_AT: '2000-01-01T00:00:00Z' }).sendText(ig, 'hello', now, now)).status, 'rejected');
    const templates = new MetaWhatsAppTemplateSender({ ...env, META_MESSAGING_MODE: 'live', WHATSAPP_NOTIFICATIONS_ENABLED: 'true' });
    await templates.sendTemplate({ notificationJobId: 'job', to: '+12145550101', templateName: 'test', languageCode: 'es', bodyParameters: [] });
    assert.equal(calls.at(-1)!.token, 'Bearer wa-token');
    globalThis.fetch = async () => new Response('{}');
    assert.equal((await sender.sendText(ig, 'hello', now, now)).status, 'unknown');
    globalThis.fetch = async () => { throw new Error('network timeout'); };
    assert.equal((await sender.sendText(ig, 'hello', now, now)).status, 'unknown');
  } finally { globalThis.fetch = original; }
});

test('authenticated WhatsApp STOP revokes consent at ingestion without waiting for the model', async () => {
  const { db, dispose } = await localD1();
  try {
    await seedCustomer(db, 'ana');
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'wa-gym' }, messages: [{ id: 'stop', from: '12145550101', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'STOP' } }],
    } }] }] });
    assert.equal((await processMetaWebhook(raw, signature(raw), { ...env, DB: db, META_MESSAGING_MODE: 'live' })).status, 200);
    assert.ok((await db.prepare('SELECT revoked_at FROM consents WHERE customer_id = ?').bind('ana').first<{ revoked_at: string }>())?.revoked_at);
    assert.equal((await db.prepare('SELECT state FROM message_inbox').first<{ state: string }>())?.state, 'pending');
  } finally { await dispose(); }
});
