import type { TemplateSendResult } from '../../../model.js';
import { alert, backoffSeconds, later } from './persistence.js';

export type DeliveryTable = 'outgoing_messages' | 'notification_jobs';

export async function recoverDeliveries(db: D1Database, table: DeliveryTable, now: string) {
  // A leased job has not made a network call. A sending job may have done so.
  await db.prepare(`UPDATE ${table} SET state = 'pending', lease_token = NULL, lease_expires_at = NULL
    WHERE state = 'leased' AND lease_expires_at <= ?`).bind(now).run();
  const uncertain = await db.prepare(`UPDATE ${table} SET state = 'unknown', last_error_code = 'worker_interrupted_during_send'
    WHERE state = 'sending' AND lease_expires_at <= ? RETURNING id`).bind(now).all<{ id: string }>();
  for (const job of uncertain.results) await alert(db, 'delivery_unknown', job.id, 'Check provider delivery before any manual retry', now);
}

export async function claimDelivery(db: D1Database, table: DeliveryTable, id: string, now: string): Promise<string | null> {
  const token = crypto.randomUUID();
  const result = await db.prepare(`UPDATE ${table} SET state = 'leased', lease_token = ?, lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND state = 'pending'`).bind(token, later(now, 120), now, id).run();
  return result.meta.changes ? token : null;
}

export async function recordDelivery(db: D1Database, table: DeliveryTable, id: string, token: string, result: TemplateSendResult, now: string) {
  const row = await db.prepare(`SELECT attempts FROM ${table} WHERE id = ? AND lease_token = ? AND state = 'sending'`).bind(id, token).first<{ attempts: number }>();
  if (!row) return; // A signed receipt may already have established a stronger outcome.
  const state = result.status === 'accepted' ? 'accepted' : result.status === 'unknown' ? 'unknown'
    : result.retryable && row.attempts < 6 ? 'pending' : 'failed';
  const code = result.status === 'rejected' ? result.code : result.status === 'unknown' ? result.reason : null;
  await db.prepare(`UPDATE ${table} SET state = ?, provider_message_id = ?, last_error_code = ?, available_at = ?,
    lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_token = ? AND state = 'sending'`)
    .bind(state, result.status === 'accepted' ? result.providerMessageId : null, code, later(now, backoffSeconds(row.attempts)), now, id, token).run();
  if (state === 'failed' || state === 'unknown') await alert(db, `delivery_${state}`, id, code ?? state, now);
}
