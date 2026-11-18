import { z } from 'zod';
import type { ChannelIdentity } from '../../model.js';

export const distribuidoraInput = z.object({ name: z.string().trim().min(1).max(100), email: z.string().trim().email().max(254) }).strict();
export const platformSchema = z.enum(['instagram', 'whatsapp', 'tiktok']);
export type Platform = z.infer<typeof platformSchema>;
export interface Distribuidora {
  id: string; name: string; email: string; active: number;
  google_calendar_id: string | null; calendar_view_url: string | null;
  calendar_setup_status: 'pending' | 'creating' | 'creation_unknown' | 'sharing' | 'ready' | 'failed';
  created_at: string; updated_at: string;
}
export interface SocialAccount {
  id: string; distribuidora_id: string; platform: Platform; provider_account_id: string; handle: string | null;
  status: 'connected' | 'disconnected' | 'needs_authorization'; credential_id: string | null; token_expires_at: string | null;
}
export interface AccountRoute { account: SocialAccount; distribuidora: Distribuidora }

export class AccountStore {
  constructor(readonly db: D1Database) {}
  async create(input: unknown, requestId?: string): Promise<Distribuidora> {
    const value = distribuidoraInput.parse(input);
    const id = requestId ? z.string().uuid().parse(requestId) : crypto.randomUUID(), now = new Date().toISOString();
    await this.db.prepare('INSERT INTO distribuidoras (id,name,email,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .bind(id, value.name, value.email.toLowerCase(), now, now).run();
    const profile = (await this.get(id))!;
    if (profile.name !== value.name || profile.email !== value.email.toLowerCase()) throw new Error('Creation request ID was reused with different profile details');
    return profile;
  }
  get(id: string) { return this.db.prepare('SELECT * FROM distribuidoras WHERE id = ?').bind(id).first<Distribuidora>(); }
  async list() { return (await this.db.prepare('SELECT * FROM distribuidoras ORDER BY created_at,id').all<Distribuidora>()).results; }
  async setActive(id: string, active: boolean) {
    await this.db.prepare('UPDATE distribuidoras SET active = ?,updated_at = ? WHERE id = ?').bind(active ? 1 : 0, new Date().toISOString(), id).run();
  }
  async resolve(identity: ChannelIdentity, allowInactive = false): Promise<AccountRoute | null> {
    const account = await this.db.prepare('SELECT * FROM social_accounts WHERE platform = ? AND provider_account_id = ?')
      .bind(identity.channel, identity.businessAccountId).first<SocialAccount>();
    if (!account) return null;
    const distribuidora = await this.get(account.distribuidora_id);
    if (!distribuidora || (!allowInactive && (account.status !== 'connected' || !distribuidora.active
      || distribuidora.calendar_setup_status !== 'ready' || !distribuidora.google_calendar_id
      || (account.token_expires_at && Date.parse(account.token_expires_at) <= Date.now())))) return null;
    return { account, distribuidora };
  }
  async setSetting(key: string, value: string) {
    await this.db.prepare('INSERT INTO gym_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, value).run();
  }
  async setting(key: string): Promise<string | null> {
    return (await this.db.prepare('SELECT value FROM gym_settings WHERE key=?').bind(key).first<{ value: string }>())?.value ?? null;
  }
  async disconnect(id: string) {
    await this.db.prepare("UPDATE social_accounts SET status='disconnected',updated_at=? WHERE id=?").bind(new Date().toISOString(), id).run();
  }
  /** Explicit projection: credential IDs/ciphertext never enter the portal response. */
  async publicAccounts() {
    return (await this.db.prepare(`SELECT id,distribuidora_id,platform,provider_account_id,handle,status,token_expires_at
      FROM social_accounts ORDER BY created_at,id`).all()).results;
  }
}
