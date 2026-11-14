import type { Env } from '../types/env.js';
import { vaultFor } from './runtime.js';
import { withLease } from '../llm-integration/runtime/persistence.js';

export class OwnerGoogleError extends Error {
  constructor(readonly status: number) { super(`Google owner operation failed (${status})`); }
}

export async function ownerGoogleToken(env: Env): Promise<string> {
  if (!env.DB) throw new Error('Database required');
  return withLease(env.DB, 'google-owner-token', async () => {
    const vault = vaultFor(env), value = await vault.get('google-owner');
    if (!value || !env.GOOGLE_OWNER_EMAIL || value.email?.toLowerCase() !== env.GOOGLE_OWNER_EMAIL.toLowerCase()) throw new Error('Gym Google account must be authorized');
    if (value.expiresAt && Date.parse(value.expiresAt) > Date.now() + 60_000) return value.accessToken;
    if (!value.refreshToken || !env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) throw new Error('Gym Google account must be reauthorized');
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: value.refreshToken, client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET }) });
    if (!response.ok) throw new OwnerGoogleError(response.status);
    const data = await response.json() as { access_token?: string; expires_in?: number };
    if (!data.access_token || !data.expires_in) throw new Error('Invalid Google refresh response');
    await vault.put('google-owner', { ...value, accessToken: data.access_token, expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString() });
    return data.access_token;
  });
}

export interface CalendarProvisioner {
  create(name: string, marker: string): Promise<string>;
  find(marker: string): Promise<string | null>;
  share(calendarId: string, email: string, role: 'reader' | 'writer', notify: boolean): Promise<void>;
}

/** Uses the gym user's OAuth token so calendars belong to the gym, not the service account. */
export class GoogleOwnerCalendars implements CalendarProvisioner {
  constructor(private env: Env) {}
  private async request(path: string, method = 'GET', body?: unknown): Promise<any> {
    const response = await fetch(`https://www.googleapis.com/calendar/v3/${path}`, { method,
      headers: { Authorization: `Bearer ${await ownerGoogleToken(this.env)}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new OwnerGoogleError(response.status);
    return response.json();
  }
  async create(name: string, marker: string) {
    const data = await this.request('calendars', 'POST', { summary: `DWC — ${name}`, description: marker, timeZone: 'America/Chicago' });
    if (typeof data.id !== 'string' || !data.id) throw new Error('Calendar creation outcome is unknown');
    return data.id;
  }
  private async list(path: string): Promise<any[]> {
    const result: any[] = [], seen = new Set<string>();
    let token = '';
    do {
      if (seen.has(token)) throw new Error('Calendar pagination did not advance');
      seen.add(token);
      const page = await this.request(`${path}${path.includes('?') ? '&' : '?'}maxResults=250${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
      result.push(...(page.items ?? [])); token = page.nextPageToken ?? '';
    } while (token);
    return result;
  }
  async find(marker: string) {
    const matches = (await this.list('users/me/calendarList?minAccessRole=owner')).filter((calendar) => calendar.description === marker);
    if (matches.length > 1) throw new Error('Multiple provisioned calendars require owner resolution');
    return matches[0]?.id ?? null;
  }
  async share(calendarId: string, email: string, role: 'reader' | 'writer', notify: boolean) {
    if (email.toLowerCase() === this.env.GOOGLE_OWNER_EMAIL?.toLowerCase() && role === 'reader') return; // Never downgrade the data owner's access.
    const path = `calendars/${encodeURIComponent(calendarId)}/acl`;
    const existing = (await this.list(path)).find((entry) => entry.scope?.type === 'user' && entry.scope.value?.toLowerCase() === email.toLowerCase());
    if (existing?.role === role) return;
    await this.request(`${path}${existing ? `/${encodeURIComponent(existing.id)}` : ''}?sendNotifications=${notify}`, existing ? 'PATCH' : 'POST',
      { role, scope: { type: 'user', value: email } });
  }
}
