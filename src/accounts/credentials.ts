import { z } from 'zod';

const payloadSchema = z.object({
  accessToken: z.string().min(1), refreshToken: z.string().min(1).optional(), expiresAt: z.string().datetime().optional(),
  scopes: z.array(z.string()).optional(), subject: z.string().optional(), email: z.string().email().optional(),
  checkpoint: z.object({ provider: z.literal('instagram'), distribuidoraId: z.string().min(1), kind: z.enum(['short', 'long']), resumeUntil: z.string().datetime() }).strict().optional(),
}).strict();
export type CredentialPayload = z.infer<typeof payloadSchema>;
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/** AES-GCM binds each ciphertext to its record ID. Old key IDs remain readable during rotation. */
export class CredentialVault {
  private keys: Record<string, string>;
  constructor(private db: D1Database, keyring: string, private activeKey: string) {
    this.keys = z.record(z.string()).parse(JSON.parse(keyring));
    if (!this.keys[activeKey]) throw new Error('Credential encryption key is not configured');
    for (const value of Object.values(this.keys)) if (decode(value).length !== 32) throw new Error('Credential encryption keys must be 32 bytes');
  }
  private async key(id: string) {
    const value = this.keys[id];
    if (!value) throw new Error('Credential encryption key is unavailable');
    const bytes = decode(value);
    if (bytes.length !== 32) throw new Error('Credential encryption key must be 32 bytes');
    return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  private async encrypt(id: string, input: CredentialPayload) {
    const payload = payloadSchema.parse(input), iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`dwc:1:${id}`) },
      await this.key(this.activeKey), new TextEncoder().encode(JSON.stringify(payload)));
    return JSON.stringify({ v: 1, kid: this.activeKey, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) });
  }
  async put(id: string, input: CredentialPayload, fence?: () => D1PreparedStatement) {
    const envelope = await this.encrypt(id, input);
    const statement = this.db.prepare('INSERT INTO account_credentials (id,encrypted_payload,updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET encrypted_payload=excluded.encrypted_payload,updated_at=excluded.updated_at')
      .bind(id, envelope, new Date().toISOString());
    await this.db.batch([...(fence ? [fence()] : []), statement]);
  }
  async get(id: string): Promise<CredentialPayload | null> {
    const row = await this.db.prepare('SELECT encrypted_payload FROM account_credentials WHERE id=?').bind(id).first<{ encrypted_payload: string }>();
    if (!row) return null;
    const envelope = z.object({ v: z.literal(1), kid: z.string(), iv: z.string(), ciphertext: z.string() }).parse(JSON.parse(row.encrypted_payload));
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(envelope.iv), additionalData: new TextEncoder().encode(`dwc:1:${id}`) },
      await this.key(envelope.kid), decode(envelope.ciphertext));
    return payloadSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
  }
  async rotate(id: string) {
    const before = await this.db.prepare('SELECT encrypted_payload FROM account_credentials WHERE id=?').bind(id).first<{ encrypted_payload: string }>();
    if (!before) return;
    const value = await this.get(id);
    if (!value) return;
    const result = await this.db.prepare('UPDATE account_credentials SET encrypted_payload=?,updated_at=? WHERE id=? AND encrypted_payload=?')
      .bind(await this.encrypt(id, value), new Date().toISOString(), id, before.encrypted_payload).run();
    if (!result.meta.changes) throw new Error('Credential changed during rotation; retry this record');
  }
}
