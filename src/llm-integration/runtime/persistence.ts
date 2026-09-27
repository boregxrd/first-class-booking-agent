import type { ChannelIdentity } from '../../../model.js';

export const identityKey = (identity: ChannelIdentity) => JSON.stringify([identity.channel, identity.businessAccountId, identity.senderId]);
export const backoffSeconds = (attempt: number) => Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));
export const later = (now: string, seconds: number) => new Date(Date.parse(now) + seconds * 1000).toISOString();

export class ConversationBusyError extends Error {
  constructor() { super('Conversation is already processing'); }
}

export interface Lease { fence(): D1PreparedStatement }

export async function withLease<T>(db: D1Database, id: string, work: (lease: Lease) => Promise<T>): Promise<T> {
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const claim = await db.prepare(`INSERT INTO processing_leases (id, token, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
    WHERE processing_leases.expires_at <= ? RETURNING token`).bind(id, token, later(now, 600), now).first();
  if (!claim) throw new ConversationBusyError();
  const lease: Lease = { fence: () => db.prepare(`UPDATE processing_leases
    SET token = CASE WHEN token = ? AND expires_at > ? THEN token ELSE NULL END WHERE id = ?`)
    .bind(token, new Date().toISOString(), id) };
  try { return await work(lease); }
  finally {
    // Leave the row so an expired writer's fence cannot succeed against a missing row.
    await db.prepare('UPDATE processing_leases SET expires_at = ? WHERE id = ? AND token = ?').bind('1970-01-01T00:00:00.000Z', id, token).run();
  }
}

export async function alert(db: D1Database, kind: string, resource: string, detail: string, now = new Date().toISOString()) {
  const id = JSON.stringify([kind, resource]);
  await db.prepare(`INSERT INTO operational_alerts (id, kind, resource_id, detail, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET detail = excluded.detail, state = 'open', updated_at = excluded.updated_at`)
    .bind(id, kind, resource, detail, now, now).run();
  console.warn('[Operational alert]', { kind, resource });
}

export async function resolveAlert(db: D1Database, kind: string, resource: string) {
  await db.prepare("UPDATE operational_alerts SET state = 'resolved', updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), JSON.stringify([kind, resource])).run();
}
