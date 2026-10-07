import type { InboundMessage, Customer, ChannelIdentity } from '../../../model.js';
import type { ConversationState } from './store.js';
import { DIRECT_CHAT_ACCOUNT } from '../runtime/direct-chat.js';

export interface ConversationControls {
  handle(message: InboundMessage, state: ConversationState, now: string): Promise<string | null>;
}

export const isOptOut = (text: string) => /^(stop|unsubscribe|no mas mensajes|no me mandes mensajes|no quiero mensajes|cancelar mensajes|baja)[.!]*$/.test(
  text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase(),
);

/** Honor authenticated opt-outs at ingestion, even if an earlier model turn is blocked. */
export async function revokeNotifications(db: D1Database, identity: ChannelIdentity, now: string) {
  const linked = await db.prepare('SELECT customer_id FROM channel_identities WHERE channel = ? AND business_account_id = ? AND sender_id = ?')
    .bind(identity.channel, identity.businessAccountId, identity.senderId).first<{ customer_id: string }>();
  const phone = identity.channel === 'whatsapp' ? `+${identity.senderId.replace(/\D/g, '')}` : null;
  await db.batch([
    db.prepare('UPDATE consents SET revoked_at = ? WHERE revoked_at IS NULL AND (customer_id = ? OR phone = ?)').bind(now, linked?.customer_id ?? null, phone),
    db.prepare(`UPDATE notification_jobs SET state = 'cancelled' WHERE state IN ('pending','leased') AND booking_id IN
      (SELECT b.id FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE c.id = ? OR c.whatsapp_phone = ?)`)
      .bind(linked?.customer_id ?? null, phone),
  ]);
}

async function hash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class D1ConversationControls implements ConversationControls {
  constructor(private readonly db: D1Database) {}
  async handle(message: InboundMessage, state: ConversationState, now: string): Promise<string | null> {
    const text = message.text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
    if (/^(english|in english|en ingles|speak english)[.!]*$/.test(text) || /^(hi|hello|hey)\b/.test(text)) state.customer.language = 'en';
    if (/^(espanol|en espanol|spanish|in spanish)[.!]*$/.test(text) || /^hola\b/.test(text)) state.customer.language = 'es';
    const es = state.customer.language === 'es';
    if (/^(english|in english|en ingles|speak english|espanol|en espanol|spanish|in spanish)[.!]*$/.test(text)) return es ? '¡Claro! Seguimos en español 💖.' : 'Of course! We’ll continue in English 💖.';
    if (text === '[unsupported media]') return es ? '¿Me lo puedes escribir en un mensaje de texto? 💖' : 'Could you send that as a text message? 💖';
    if (isOptOut(text)) {
      await revokeNotifications(this.db, message.identity, now);
      if (state.customer.whatsappConsent) state.customer.whatsappConsent.revokedAt = now;
      state.proposal = null;
      return es ? 'He desactivado las confirmaciones y recordatorios por WhatsApp. Tu reserva no se cancela.' : 'WhatsApp confirmations and reminders are turned off. Your booking is unchanged.';
    }
    if (/^(link whatsapp|vincular whatsapp)$/.test(text)) {
      if (message.identity.businessAccountId === DIRECT_CHAT_ACCOUNT) return es ? 'La vinculación con WhatsApp se prueba desde Instagram, no desde este chat de prueba.' : 'Test WhatsApp linking from Instagram, rather than this test chat.';
      if (message.identity.channel !== 'instagram' || !state.customer.whatsappPhone) {
        return es ? 'Solicita “vincular WhatsApp” desde Instagram después de confirmar tu número en la reserva.' : 'Request “link WhatsApp” from Instagram after confirming your booking phone number.';
      }
      const code = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      await this.db.prepare('INSERT INTO identity_link_codes (code_hash, customer_id, phone, expires_at) VALUES (?, ?, ?, ?)')
        .bind(await hash(code), state.customer.id, state.customer.whatsappPhone, new Date(Date.parse(now) + 15 * 60_000).toISOString()).run();
      return es ? `Desde tu WhatsApp envíanos “vincular ${code}” para conectar tus chats. El código vence en 15 minutos.` : `From your WhatsApp, send us “link ${code}” to connect your chats. The code expires in 15 minutes.`;
    }
    const match = /^(?:link|vincular) ([a-f0-9]{12})$/.exec(text);
    if (!match) return null;
    const invalid = es ? 'No pude vincular ese código. Pide uno nuevo desde tu chat de Instagram y envíalo desde el número registrado.' : 'That code could not be linked. Request a new one in Instagram and send it from the registered number.';
    if (message.identity.channel !== 'whatsapp') return invalid;
    const codeHash = await hash(match[1]!);
    const row = await this.db.prepare('SELECT * FROM identity_link_codes WHERE code_hash = ?').bind(codeHash)
      .first<{ customer_id: string; phone: string; expires_at: string; used_at: string | null }>();
    const phone = `+${message.identity.senderId.replace(/\D/g, '')}`;
    if (!row || row.expires_at <= now || row.phone !== phone) return invalid;
    if (row.used_at && row.customer_id !== state.customer.id) return invalid;
    if (row.customer_id !== state.customer.id && (state.customer.name || await this.db.prepare('SELECT id FROM bookings WHERE customer_id = ?').bind(state.customer.id).first())) {
      return es ? 'Este chat ya tiene datos de otra reserva. No lo vinculé para evitar mezclar clientes.' : 'This chat already has another customer record. It was not linked to avoid mixing customers.';
    }
    const target = await this.db.prepare('SELECT * FROM customers WHERE id = ?').bind(row.customer_id)
      .first<{ id: string; name: string | null; whatsapp_phone: string | null; instagram_handle: string | null; language: Customer['language']; created_at: string; updated_at: string }>();
    if (!target || target.whatsapp_phone !== phone) return invalid;
    if (!row.used_at) await this.db.batch([
      this.db.prepare(`UPDATE identity_link_codes SET phone = CASE WHEN used_at IS NULL AND expires_at > ? THEN phone ELSE NULL END,
        used_at = ? WHERE code_hash = ?`).bind(now, now, codeHash),
      this.db.prepare('UPDATE channel_identities SET customer_id = ?, updated_at = ? WHERE channel = ? AND business_account_id = ? AND sender_id = ?')
        .bind(target.id, now, message.identity.channel, message.identity.businessAccountId, message.identity.senderId),
      this.db.prepare('UPDATE conversations SET customer_id = ? WHERE id = ?').bind(target.id, state.id),
    ]);
    state.customer = { id: target.id, name: target.name, whatsappPhone: target.whatsapp_phone, instagramHandle: target.instagram_handle,
      language: target.language, whatsappConsent: null, createdAt: target.created_at, updatedAt: target.updated_at };
    state.proposal = null;
    return target.language === 'es' ? '¡Listo! Instagram y WhatsApp ahora comparten tu reserva 💖.' : 'Your Instagram and WhatsApp chats now share your booking 💖.';
  }
}
