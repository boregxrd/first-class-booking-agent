import { z } from 'zod';
import type { ChannelIdentity } from '../../model.js';
import type { Env } from '../types/env.js';
import { DIRECT_CHAT_ACCOUNT } from '../llm-integration/runtime/direct-chat.js';

const profileSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/u).nullish(),
  username: z.string().regex(/^[a-zA-Z0-9._]{1,30}$/).nullish(),
});

export interface InstagramProfile {
  name: string | null;
  username: string | null;
}

export function isInstagramDm(identity: ChannelIdentity): boolean {
  return identity.channel === 'instagram' && identity.businessAccountId !== DIRECT_CHAT_ACCOUNT;
}

/** The DM webhook supplies a scoped ID. Names/usernames require this separate API read. */
export class MetaInstagramProfileReader {
  constructor(private readonly env: Env, private readonly request: typeof fetch = fetch) {}

  async getProfile(identity: ChannelIdentity): Promise<InstagramProfile | null> {
    if (!isInstagramDm(identity) || identity.businessAccountId !== this.env.META_INSTAGRAM_ACCOUNT_ID
      || !this.env.META_INSTAGRAM_ACCESS_TOKEN || !/^v\d+\.\d+$/.test(this.env.META_GRAPH_API_VERSION ?? '')) return null;
    const expiry = this.env.META_INSTAGRAM_TOKEN_EXPIRES_AT;
    if (expiry && (!Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now())) return null;
    try {
      const url = new URL(`https://graph.instagram.com/${this.env.META_GRAPH_API_VERSION}/${encodeURIComponent(identity.senderId)}`);
      url.searchParams.set('fields', 'id,name,username');
      const response = await this.request(url, {
        headers: { Authorization: `Bearer ${this.env.META_INSTAGRAM_ACCESS_TOKEN}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { code?: number; error_subcode?: number } } | null;
        console.warn('[Instagram profile unavailable]', { reason: 'provider_rejected', status: response.status,
          code: body?.error?.code, subcode: body?.error?.error_subcode });
        return null;
      }
      const profile = profileSchema.safeParse(await response.json());
      if (!profile.success || profile.data.id !== identity.senderId) {
        console.warn('[Instagram profile unavailable]', { reason: profile.success ? 'identity_mismatch' : 'invalid_profile_fields' });
        return null;
      }
      return { name: profile.data.name ?? null, username: profile.data.username ?? null };
    } catch {
      console.warn('[Instagram profile unavailable]', { reason: 'network_or_response_error' });
      // A denied/failed optional lookup must not block the conversation or inbox recovery.
      return null;
    }
  }
}
