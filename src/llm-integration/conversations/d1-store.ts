import { ChannelIdentity, Customer, InboundMessage } from '../../../model.js';
import { ConversationSession, ConversationState, ConversationStore, TurnResult } from './store.js';

export class D1ConversationStore implements ConversationStore {
  constructor(private db: D1Database) {}

  async withConversation<T>(
    identity: ChannelIdentity,
    work: (session: ConversationSession) => Promise<T>
  ): Promise<T> {
    const now = new Date().toISOString();

    // 1. Get or create Customer & ChannelIdentity
    const identityRow = await this.db
      .prepare(
        `SELECT ci.customer_id, c.name, c.whatsapp_phone, c.language, c.created_at, c.updated_at
         FROM channel_identities ci
         JOIN customers c ON ci.customer_id = c.id
         WHERE ci.channel = ? AND ci.business_account_id = ? AND ci.sender_id = ?`
      )
      .bind(identity.channel, identity.businessAccountId, identity.senderId)
      .first<{
        customer_id: string;
        name: string | null;
        whatsapp_phone: string | null;
        language: 'es' | 'en';
        created_at: string;
        updated_at: string;
      }>();

    let customerId: string;
    let customer: Customer;

    if (identityRow) {
      customerId = identityRow.customer_id;
      customer = {
        id: customerId,
        name: identityRow.name,
        whatsappPhone: identityRow.whatsapp_phone,
        language: identityRow.language,
        whatsappConsent: null, // Loaded on demand if present in consents table
        createdAt: identityRow.created_at,
        updatedAt: identityRow.updated_at,
      };
    } else {
      customerId = `cust_${crypto.randomUUID()}`;
      customer = {
        id: customerId,
        name: null,
        whatsappPhone: identity.channel === 'whatsapp' ? `+${identity.senderId.replace(/\D/g, '')}` : null,
        language: 'es',
        whatsappConsent: null,
        createdAt: now,
        updatedAt: now,
      };

      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO customers (id, name, whatsapp_phone, language, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .bind(customer.id, customer.name, customer.whatsappPhone, customer.language, now, now),
        this.db
          .prepare(
            `INSERT INTO channel_identities (channel, business_account_id, sender_id, customer_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .bind(identity.channel, identity.businessAccountId, identity.senderId, customerId, now, now),
      ]);
    }

    // 2. Get or create Conversation
    let convRow = await this.db
      .prepare(
        `SELECT id, pending_proposal, revision
         FROM conversations
         WHERE channel = ? AND business_account_id = ? AND sender_id = ?`
      )
      .bind(identity.channel, identity.businessAccountId, identity.senderId)
      .first<{ id: string; pending_proposal: string | null; revision: number }>();

    let conversationId: string;
    let pendingProposal: ConversationState['proposal'] = null;

    if (convRow) {
      conversationId = convRow.id;
      if (convRow.pending_proposal) {
        try {
          pendingProposal = JSON.parse(convRow.pending_proposal);
        } catch {
          pendingProposal = null;
        }
      }
    } else {
      conversationId = `conv_${crypto.randomUUID()}`;
      await this.db
        .prepare(
          `INSERT INTO conversations (id, customer_id, channel, business_account_id, sender_id, revision, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?)`
        )
        .bind(conversationId, customerId, identity.channel, identity.businessAccountId, identity.senderId, now)
        .run();
    }

    // 3. Load recent conversation history (last 10 turns)
    const messageRows = await this.db
      .prepare(
        `SELECT role, text
         FROM messages
         WHERE conversation_id = ?
         ORDER BY created_at ASC
         LIMIT 20`
      )
      .bind(conversationId)
      .all<{ role: 'user' | 'assistant'; text: string }>();

    const history: Array<{ role: 'user' | 'assistant'; content: string }> = (messageRows.results || []).map(
      (row) => ({
        role: row.role,
        content: row.text,
      })
    );

    const state: ConversationState = {
      id: conversationId,
      customer,
      history,
      proposal: pendingProposal,
      bookingOperation: null,
    };

    const db = this.db;

    const session: ConversationSession = {
      state,

      async getProcessedTurn(providerMessageId: string): Promise<TurnResult | null> {
        const row = await db
          .prepare(
            `SELECT result_json
             FROM booking_operations
             WHERE customer_id = ? AND operation_key = ?`
          )
          .bind(customerId, `webhook_${providerMessageId}`)
          .first<{ result_json: string }>();

        if (row?.result_json) {
          try {
            return JSON.parse(row.result_json);
          } catch {
            return null;
          }
        }
        return null;
      },

      async save(updatedState: ConversationState): Promise<void> {
        const timestamp = new Date().toISOString();
        await db.batch([
          db
            .prepare(
              `UPDATE customers
               SET name = ?, whatsapp_phone = ?, language = ?, updated_at = ?
               WHERE id = ?`
            )
            .bind(
              updatedState.customer.name,
              updatedState.customer.whatsappPhone,
              updatedState.customer.language,
              timestamp,
              updatedState.customer.id
            ),
          db
            .prepare(
              `UPDATE conversations
               SET pending_proposal = ?, updated_at = ?
               WHERE id = ?`
            )
            .bind(
              updatedState.proposal ? JSON.stringify(updatedState.proposal) : null,
              timestamp,
              updatedState.id
            ),
        ]);
      },

      async complete(message: InboundMessage, finalState: ConversationState, result: TurnResult): Promise<void> {
        const timestamp = new Date().toISOString();
        const userMsgId = `msg_${crypto.randomUUID()}`;
        const assistantMsgId = `msg_${crypto.randomUUID()}`;

        await db.batch([
          // 1. Inbound user message
          db
            .prepare(
              `INSERT INTO messages (id, conversation_id, channel, business_account_id, sender_id, provider_message_id, role, text, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?)`
            )
            .bind(
              userMsgId,
              finalState.id,
              identity.channel,
              identity.businessAccountId,
              identity.senderId,
              message.providerMessageId,
              message.text,
              timestamp
            ),
          // 2. Outbound assistant reply
          db
            .prepare(
              `INSERT INTO messages (id, conversation_id, channel, business_account_id, sender_id, role, text, created_at)
               VALUES (?, ?, ?, ?, ?, 'assistant', ?, ?)`
            )
            .bind(
              assistantMsgId,
              finalState.id,
              identity.channel,
              identity.businessAccountId,
              identity.senderId,
              result.reply,
              timestamp
            ),
          // 3. Mark webhook as processed for idempotency
          db
            .prepare(
              `INSERT OR REPLACE INTO processed_webhooks (channel, business_account_id, provider_message_id, processed_at)
               VALUES (?, ?, ?, ?)`
            )
            .bind(identity.channel, identity.businessAccountId, message.providerMessageId, timestamp),
          // 4. Update customer and conversation checkpoint
          db
            .prepare(
              `UPDATE customers
               SET name = ?, whatsapp_phone = ?, language = ?, updated_at = ?
               WHERE id = ?`
            )
            .bind(
              finalState.customer.name,
              finalState.customer.whatsappPhone,
              finalState.customer.language,
              timestamp,
              finalState.customer.id
            ),
          db
            .prepare(
              `UPDATE conversations
               SET pending_proposal = ?, revision = revision + 1, updated_at = ?
               WHERE id = ?`
            )
            .bind(
              finalState.proposal ? JSON.stringify(finalState.proposal) : null,
              timestamp,
              finalState.id
            ),
          // 5. Store turn result for replay
          db
            .prepare(
              `INSERT OR REPLACE INTO booking_operations (operation_key, customer_id, action, argument_fingerprint, status, result_json, created_at, updated_at)
               VALUES (?, ?, 'turn', ?, 'succeeded', ?, ?, ?)`
            )
            .bind(
              `webhook_${message.providerMessageId}`,
              customerId,
              message.providerMessageId,
              JSON.stringify(result),
              timestamp,
              timestamp
            ),
        ]);
      },
    };

    return work(session);
  }
}
