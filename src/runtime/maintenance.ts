import { alert } from '../llm-integration/runtime/persistence.js';
import type { Env } from '../types/env.js';

export async function maintainState(db: D1Database, env: Env, now: string) {
  const cutoff = (days: number) => new Date(Date.parse(now) - days * 86_400_000).toISOString();
  await db.batch([
    db.prepare("DELETE FROM messages WHERE created_at < ?").bind(cutoff(30)),
    db.prepare("UPDATE message_inbox SET payload = '{}' WHERE state = 'processed' AND created_at < ?").bind(cutoff(30)),
    db.prepare("UPDATE outgoing_messages SET text = '' WHERE state IN ('accepted','cancelled','failed','unknown') AND updated_at < ?").bind(cutoff(30)),
    db.prepare("DELETE FROM processed_turns WHERE processed_at < ?").bind(cutoff(90)),
    db.prepare("DELETE FROM processed_webhooks WHERE processed_at < ?").bind(cutoff(90)),
    db.prepare("DELETE FROM identity_link_codes WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM notification_delivery_events WHERE received_at < ?").bind(cutoff(90)),
    db.prepare("UPDATE conversations SET pending_proposal = NULL WHERE json_extract(pending_proposal, '$.expiresAt') <= ?").bind(now),
    db.prepare(`UPDATE bookings SET status = 'elapsed', updated_at = ? WHERE status = 'confirmed' AND ends_at < ?
      AND NOT EXISTS (SELECT 1 FROM booking_operations op WHERE op.booking_id = bookings.id AND op.status = 'pending')`).bind(now, now),
  ]);
  for (const [channel, expiry] of [['instagram', env.META_INSTAGRAM_TOKEN_EXPIRES_AT], ['whatsapp', env.META_WHATSAPP_TOKEN_EXPIRES_AT]]) {
    if (expiry && (!Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) < Date.parse(now) + 7 * 86_400_000)) {
      await alert(db, 'token_expiring', channel!, 'Refresh/re-authorize the channel token and update its secret and expiry', now);
    }
  }
  const stuck = await db.prepare("SELECT booking_id FROM booking_operations WHERE status = 'pending' AND created_at < ? ORDER BY created_at LIMIT 10")
    .bind(new Date(Date.parse(now) - 15 * 60_000).toISOString()).all<{ booking_id: string }>();
  for (const operation of stuck.results) await alert(db, 'booking_sync_pending', operation.booking_id, 'Booking has awaited Calendar reconciliation for over 15 minutes', now);
  await db.prepare(`UPDATE operational_alerts SET state = 'resolved', updated_at = ? WHERE kind = 'booking_sync_pending'
    AND NOT EXISTS (SELECT 1 FROM booking_operations op WHERE op.booking_id = operational_alerts.resource_id AND op.status = 'pending')`).bind(now).run();
}
