import type { ChannelIdentity } from '../../../model.js';
import type { TextSender } from '../../channels/outbound.js';
import { claimDelivery, recordDelivery, recoverDeliveries } from './delivery.js';

export async function dispatchOutbox(db: D1Database, sender: TextSender, now = new Date().toISOString()) {
  await recoverDeliveries(db, 'outgoing_messages', now);
  const rows = await db.prepare(`SELECT o.* FROM outgoing_messages o WHERE o.state = 'pending' AND o.available_at <= ?
    AND NOT EXISTS (SELECT 1 FROM outgoing_messages previous WHERE previous.conversation_id = o.conversation_id
      AND previous.rowid < o.rowid AND previous.state IN ('pending','leased','sending','unknown','failed'))
    ORDER BY o.rowid LIMIT 20`).bind(now).all<{
      id: string; channel: ChannelIdentity['channel']; business_account_id: string; sender_id: string;
      text: string; last_inbound_at: string;
    }>();
  for (const row of rows.results) {
    const token = await claimDelivery(db, 'outgoing_messages', row.id, now);
    if (!token) continue;
    const latest = await db.prepare('SELECT max(sent_at) AS sent_at FROM message_inbox WHERE channel = ? AND business_account_id = ? AND sender_id = ?')
      .bind(row.channel, row.business_account_id, row.sender_id).first<{ sent_at: string | null }>();
    const marked = await db.prepare("UPDATE outgoing_messages SET state = 'sending', attempts = attempts + 1 WHERE id = ? AND lease_token = ? AND state = 'leased'").bind(row.id, token).run();
    if (!marked.meta.changes) continue;
    let result;
    try { result = await sender.sendText({ channel: row.channel, businessAccountId: row.business_account_id, senderId: row.sender_id }, row.text, latest?.sent_at ?? row.last_inbound_at, now, row.id); }
    catch { result = { status: 'unknown' as const, reason: 'sender_interrupted' }; }
    await recordDelivery(db, 'outgoing_messages', row.id, token, result, now);
  }
}
