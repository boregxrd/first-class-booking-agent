import { TemplateSendResult, WhatsAppTemplateRequest, WhatsAppTemplateSender } from '../../model.js';
import { Env } from '../types/env.js';

export interface OutboundSendResult {
  success: boolean;
  providerMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Sends a direct text message reply to an Instagram user (IGSID).
 */
export async function sendInstagramReply(
  recipientIgsid: string,
  text: string,
  accessToken: string
): Promise<OutboundSendResult> {
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(accessToken)}`;

  const body = {
    recipient: { id: recipientIgsid },
    message: { text },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = (await res.json()) as any;
    if (!res.ok || data.error) {
      console.error('[Outbound Instagram] Send failed:', data.error);
      return {
        success: false,
        errorCode: data.error?.code?.toString() || 'SEND_FAILED',
        errorMessage: data.error?.message || 'Instagram send failed',
      };
    }

    return {
      success: true,
      providerMessageId: data.message_id,
    };
  } catch (err: any) {
    console.error('[Outbound Instagram] Network error:', err);
    return {
      success: false,
      errorCode: 'NETWORK_ERROR',
      errorMessage: err.message,
    };
  }
}

/**
 * Sends an in-window WhatsApp customer service message.
 */
export async function sendWhatsAppText(
  recipientPhone: string,
  text: string,
  phoneNumberId: string,
  accessToken: string
): Promise<OutboundSendResult> {
  const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}/messages`;

  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipientPhone.replace(/\D/g, ''),
    type: 'text',
    text: { body: text },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = (await res.json()) as any;
    if (!res.ok || data.error) {
      console.error('[Outbound WhatsApp] Send failed:', data.error);
      return {
        success: false,
        errorCode: data.error?.code?.toString() || 'SEND_FAILED',
        errorMessage: data.error?.message || 'WhatsApp send failed',
      };
    }

    return {
      success: true,
      providerMessageId: data.messages?.[0]?.id,
    };
  } catch (err: any) {
    console.error('[Outbound WhatsApp] Network error:', err);
    return {
      success: false,
      errorCode: 'NETWORK_ERROR',
      errorMessage: err.message,
    };
  }
}

/**
 * Implements WhatsAppTemplateSender for Meta-approved utility templates.
 */
export class MetaWhatsAppTemplateSender implements WhatsAppTemplateSender {
  constructor(private env: Env) {}

  async sendTemplate(request: WhatsAppTemplateRequest): Promise<TemplateSendResult> {
    const accessToken = this.env.META_ACCESS_TOKEN;
    const phoneNumberId = this.env.META_PHONE_NUMBER_ID;

    if (!accessToken || !phoneNumberId) {
      console.warn('[WhatsAppTemplateSender] Missing META_ACCESS_TOKEN or META_PHONE_NUMBER_ID');
      return {
        status: 'rejected',
        code: 'CREDENTIALS_MISSING',
        retryable: false,
      };
    }

    const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}/messages`;

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: request.to.replace(/\D/g, ''),
      type: 'template',
      template: {
        name: request.templateName,
        language: { code: request.languageCode },
        components: [
          {
            type: 'body',
            parameters: request.bodyParameters.map((text) => ({
              type: 'text',
              text,
            })),
          },
        ],
      },
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const data = (await res.json()) as any;
      if (!res.ok || data.error) {
        console.error('[WhatsAppTemplateSender] Template send error:', data.error);
        return {
          status: 'rejected',
          code: data.error?.code?.toString() || 'TEMPLATE_ERROR',
          retryable: data.error?.is_transient ?? false,
        };
      }

      const providerMessageId = data.messages?.[0]?.id;
      return {
        status: 'accepted',
        providerMessageId: providerMessageId || 'wamid_accepted',
      };
    } catch (err: any) {
      console.error('[WhatsAppTemplateSender] Ambiguous timeout or network error:', err);
      return {
        status: 'unknown',
        reason: err.message || 'Network request failed',
      };
    }
  }
}
