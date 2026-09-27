import type { ChannelIdentity, TemplateSendResult, WhatsAppTemplateRequest, WhatsAppTemplateSender } from '../../model.js';
import type { Env } from '../types/env.js';
import { canProcessMessages } from '../llm-integration/runtime/test-access.js';

export interface TextSender {
  sendText(identity: ChannelIdentity, text: string, lastInboundAt: string, now?: string, correlationId?: string): Promise<TemplateSendResult>;
}

/** Explicit rejection is retryable only when the provider says it did not accept it. */
async function post(url: string, token: string, body: unknown, provider: 'instagram' | 'whatsapp'): Promise<TemplateSendResult> {
  try {
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    if (response.status >= 500) return { status: 'unknown', reason: 'provider_server_error' };
    if (!response.ok) {
      const data = await response.json().catch(() => null) as { error?: { code?: number } } | null;
      return { status: 'rejected', code: data?.error?.code === 190 ? 'TOKEN_EXPIRED_OR_INVALID' : `HTTP_${response.status}`, retryable: response.status === 429 };
    }
    const data = await response.json() as { message_id?: unknown; messages?: Array<{ id?: unknown }> };
    const id = provider === 'instagram' ? data.message_id : data.messages?.[0]?.id;
    return typeof id === 'string' && id ? { status: 'accepted', providerMessageId: id } : { status: 'unknown', reason: 'missing_provider_message_id' };
  } catch { return { status: 'unknown', reason: 'network_or_response_uncertain' }; }
}

function tokenError(token: string | undefined, expiry: string | undefined, now: string): TemplateSendResult | null {
  if (!token) return { status: 'rejected', code: 'CREDENTIALS_MISSING', retryable: true };
  if (expiry && (!Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.parse(now))) {
    return { status: 'rejected', code: 'TOKEN_EXPIRED_OR_INVALID', retryable: false };
  }
  return null;
}

export class MetaTextSender implements TextSender {
  constructor(private readonly env: Env) {}
  async sendText(identity: ChannelIdentity, text: string, lastInboundAt: string, now = new Date().toISOString(), correlationId?: string): Promise<TemplateSendResult> {
    if (!canProcessMessages(identity, this.env)) return { status: 'rejected', code: 'SENDER_NOT_ENABLED', retryable: false };
    if (!Number.isFinite(Date.parse(lastInboundAt)) || Date.parse(now) - Date.parse(lastInboundAt) >= 24 * 60 * 60_000) {
      return { status: 'rejected', code: 'MESSAGING_WINDOW_CLOSED', retryable: false };
    }
    const instagram = identity.channel === 'instagram';
    const token = instagram ? this.env.META_INSTAGRAM_ACCESS_TOKEN : this.env.META_WHATSAPP_ACCESS_TOKEN;
    const expiry = instagram ? this.env.META_INSTAGRAM_TOKEN_EXPIRES_AT : this.env.META_WHATSAPP_TOKEN_EXPIRES_AT;
    const problem = tokenError(token, expiry, now);
    if (problem) return problem;
    const account = instagram ? this.env.META_INSTAGRAM_ACCOUNT_ID : this.env.META_WHATSAPP_PHONE_NUMBER_ID;
    if (identity.businessAccountId !== account || !/^v\d+\.\d+$/.test(this.env.META_GRAPH_API_VERSION ?? '')) {
      return { status: 'rejected', code: 'CHANNEL_CONFIG_INVALID', retryable: false };
    }
    const url = `https://${instagram ? 'graph.instagram.com' : 'graph.facebook.com'}/${this.env.META_GRAPH_API_VERSION}/${encodeURIComponent(account!)}/messages`;
    return post(url, token!, instagram
      ? { recipient: { id: identity.senderId }, message: { text } }
      : { messaging_product: 'whatsapp', to: identity.senderId.replace(/\D/g, ''), type: 'text', text: { body: text }, biz_opaque_callback_data: correlationId }, identity.channel);
  }
}

export class MetaWhatsAppTemplateSender implements WhatsAppTemplateSender {
  constructor(private readonly env: Env) {}
  async sendTemplate(request: WhatsAppTemplateRequest): Promise<TemplateSendResult> {
    if (this.env.WHATSAPP_NOTIFICATIONS_ENABLED !== 'true' || !request.templateName
      || !canProcessMessages({ channel: 'whatsapp', businessAccountId: this.env.META_WHATSAPP_PHONE_NUMBER_ID ?? '', senderId: request.to.replace(/\D/g, '') }, this.env)) {
      return { status: 'rejected', code: 'NOTIFICATIONS_NOT_ENABLED', retryable: false };
    }
    const problem = tokenError(this.env.META_WHATSAPP_ACCESS_TOKEN, this.env.META_WHATSAPP_TOKEN_EXPIRES_AT, new Date().toISOString());
    if (problem) return problem;
    if (!this.env.META_WHATSAPP_PHONE_NUMBER_ID || !/^v\d+\.\d+$/.test(this.env.META_GRAPH_API_VERSION ?? '')) {
      return { status: 'rejected', code: 'CHANNEL_CONFIG_INVALID', retryable: false };
    }
    return post(`https://graph.facebook.com/${this.env.META_GRAPH_API_VERSION}/${encodeURIComponent(this.env.META_WHATSAPP_PHONE_NUMBER_ID)}/messages`, this.env.META_WHATSAPP_ACCESS_TOKEN!, {
      messaging_product: 'whatsapp', to: request.to.replace(/\D/g, ''), type: 'template', biz_opaque_callback_data: request.notificationJobId,
      template: { name: request.templateName, language: { code: request.languageCode },
        components: [{ type: 'body', parameters: request.bodyParameters.map((text) => ({ type: 'text', text })) }] },
    }, 'whatsapp');
  }
}
