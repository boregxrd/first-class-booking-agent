import type { InboundMessage } from '../../../model.js';
import type { TurnResult } from '../conversations/store.js';
import { alert, backoffSeconds, ConversationBusyError, later, resolveAlert } from './persistence.js';

/** D1 is the durable inbox. Queue messages are wake-ups; cron recovers lost wake-ups. */
export async function ingest(db: D1Database, messages: InboundMessage[], queue?: Queue) {
  if (!messages.length) return;
  await db.batch(messages.map((message) => db.prepare(`INSERT INTO message_inbox
    (channel, business_account_id, sender_id, provider_message_id, payload, sent_at, available_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(channel, business_account_id, provider_message_id) DO NOTHING`)
    .bind(message.identity.channel, message.identity.businessAccountId, message.identity.senderId, message.providerMessageId,
      JSON.stringify(message), message.sentAt, message.receivedAt, message.receivedAt)));
  if (queue) {
    try { await queue.send({ type: 'inbox' }); await resolveAlert(db, 'queue_wakeup_failed', 'inbox'); }
    catch { await alert(db, 'queue_wakeup_failed', 'inbox', 'Cron will retry the durable inbox'); }
  }
}

export async function drainInbox(db: D1Database, processor: (message: InboundMessage) => Promise<TurnResult>, limit = 20, now = new Date().toISOString()) {
  let processed = 0;
  for (let index = 0; index < limit; index++) {
    const row = await db.prepare(`SELECT i.* FROM message_inbox i WHERE i.state = 'pending' AND i.available_at <= ?
      AND NOT EXISTS (SELECT 1 FROM message_inbox earlier WHERE earlier.channel = i.channel
        AND earlier.business_account_id = i.business_account_id AND earlier.sender_id = i.sender_id
        AND earlier.seq < i.seq AND earlier.state IN ('pending', 'failed')) ORDER BY i.seq LIMIT 1`)
      .bind(now).first<{ seq: number; payload: string; attempts: number }>();
    if (!row) break;
    try {
      await processor(JSON.parse(row.payload));
      // complete() commits this alongside the reply; update also covers a dedup replay.
      await db.prepare("UPDATE message_inbox SET state = 'processed' WHERE seq = ?").bind(row.seq).run();
      await resolveAlert(db, 'inbox_failed', String(row.seq));
      processed++;
    } catch (error) {
      if (error instanceof ConversationBusyError) break;
      const attempts = row.attempts + 1;
      const state = attempts >= 6 ? 'failed' : 'pending';
      await db.prepare(`UPDATE message_inbox SET attempts = ?, available_at = ?, state = ?, last_error = 'processing_failed' WHERE seq = ? AND state = 'pending'`)
        .bind(attempts, later(now, backoffSeconds(attempts)), state, row.seq).run();
      if (state === 'failed') await alert(db, 'inbox_failed', String(row.seq), 'Retry manually after fixing the processor; later messages remain ordered', now);
      break;
    }
  }
  return processed;
}

/** Finish already-authorized actions that Calendar reconciliation completed later. */
export async function resumeCompletedActions(db: D1Database, processor: (message: InboundMessage) => Promise<TurnResult>, now: string) {
  const rows = await db.prepare(`SELECT c.channel, c.business_account_id, c.sender_id, op.operation_key,
    COALESCE((SELECT max(i.sent_at) FROM message_inbox i WHERE i.channel = c.channel AND i.business_account_id = c.business_account_id AND i.sender_id = c.sender_id),
      (SELECT max(m.created_at) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user')) AS last_inbound_at
    FROM conversations c JOIN booking_operations op ON op.customer_id = c.customer_id
    AND op.operation_key = json_extract(c.booking_operation, '$.context.operationKey')
    WHERE c.booking_operation IS NOT NULL AND op.status = 'succeeded' LIMIT 10`)
    .all<{ channel: InboundMessage['identity']['channel']; business_account_id: string; sender_id: string; operation_key: string; last_inbound_at: string | null }>();
  for (const row of rows.results) {
    if (!row.last_inbound_at) continue;
    try {
      await processor({ identity: { channel: row.channel, businessAccountId: row.business_account_id, senderId: row.sender_id },
        providerMessageId: `operation-completed:${row.operation_key}`, text: '[Previously confirmed booking operation completed]',
        sentAt: row.last_inbound_at, receivedAt: now });
    } catch (error) { if (!(error instanceof ConversationBusyError)) throw error; }
  }
}
