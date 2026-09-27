import { ChannelIdentity, Customer, InboundMessage } from '../../../model.js';
import { ConversationSession, ConversationState, ConversationStore, TurnResult } from './store.js';
import { identityKey, withLease, type Lease } from '../runtime/persistence.js';

export class D1ConversationStore implements ConversationStore {
  constructor(private db: D1Database) {}

  async withConversation<T>(
    identity: ChannelIdentity,
    work: (session: ConversationSession) => Promise<T>
  ): Promise<T> {
    return withLease(this.db, `conversation:${identityKey(identity)}`, (lease) => this.loadSession(identity, work, lease));
  }

  private async loadSession<T>(identity: ChannelIdentity, work: (session: ConversationSession) => Promise<T>, lease: Lease): Promise<T> {
    const now = new Date().toISOString();

    // 1. Get or create Customer & ChannelIdentity
    const identityRow = await this.db
      .prepare(
        `SELECT ci.customer_id, c.name, c.whatsapp_phone, c.instagram_handle, c.language, c.created_at, c.updated_at
         FROM channel_identities ci
         JOIN customers c ON ci.customer_id = c.id
         WHERE ci.channel = ? AND ci.business_account_id = ? AND ci.sender_id = ?`
      )
      .bind(identity.channel, identity.businessAccountId, identity.senderId)
      .first<{
        customer_id: string;
        name: string | null;
        whatsapp_phone: string | null;
        instagram_handle: string | null;
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
        instagramHandle: identityRow.instagram_handle,
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
        lease.fence(),
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
         `SELECT id, pending_proposal, booking_operation, revision
         FROM conversations
         WHERE channel = ? AND business_account_id = ? AND sender_id = ?`
      )
      .bind(identity.channel, identity.businessAccountId, identity.senderId)
      .first<{ id: string; pending_proposal: string | null; booking_operation: string | null; revision: number }>();

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
      await this.db.batch([lease.fence(), this.db
        .prepare(
          `INSERT INTO conversations (id, customer_id, channel, business_account_id, sender_id, revision, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?)`
        )
        .bind(conversationId, customerId, identity.channel, identity.businessAccountId, identity.senderId, now)
      ]);
    }

    // 3. Load recent conversation history (last 10 turns)
    const messageRows = await this.db
      .prepare(
        `SELECT role, text
         FROM messages
         WHERE conversation_id = ?
          ORDER BY created_at DESC, rowid DESC
         LIMIT 20`
      )
      .bind(conversationId)
      .all<{ role: 'user' | 'assistant'; text: string }>();

    const history: Array<{ role: 'user' | 'assistant'; content: string }> = (messageRows.results || []).reverse().map(
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
      bookingOperation: convRow?.booking_operation ? JSON.parse(convRow.booking_operation) : null,
    };

    const db = this.db;

    const consent = await db.prepare(
      `SELECT phone, purpose, granted_at, source_channel, source_business_account_id, source_sender_id, source_message_id, revoked_at
       FROM consents WHERE customer_id = ? ORDER BY granted_at DESC, rowid DESC LIMIT 1`
    ).bind(customerId).first<{
      phone: string; purpose: 'trial_confirmation_and_reminders'; granted_at: string;
      source_channel: ChannelIdentity['channel']; source_business_account_id: string;
      source_sender_id: string; source_message_id: string; revoked_at: string | null;
    }>();
    if (consent) customer.whatsappConsent = {
      phone: consent.phone, purpose: consent.purpose, grantedAt: consent.granted_at,
      sourceIdentity: { channel: consent.source_channel, businessAccountId: consent.source_business_account_id, senderId: consent.source_sender_id },
      sourceMessageId: consent.source_message_id, revokedAt: consent.revoked_at,
    };

    const checkpointStatements = (value: ConversationState, timestamp: string): D1PreparedStatement[] => {
      const statements = [
        db.prepare(`UPDATE customers SET name = ?, whatsapp_phone = ?, instagram_handle = ?, language = ?, updated_at = ? WHERE id = ?`)
          .bind(value.customer.name, value.customer.whatsappPhone, value.customer.instagramHandle ?? null, value.customer.language, timestamp, value.customer.id),
        db.prepare(`UPDATE conversations SET pending_proposal = ?, booking_operation = ?, revision = revision + 1, updated_at = ? WHERE id = ?`)
          .bind(value.proposal ? JSON.stringify(value.proposal) : null, value.bookingOperation ? JSON.stringify(value.bookingOperation) : null, timestamp, value.id),
      ];
      const evidence = value.customer.whatsappConsent;
      if (evidence) statements.push(db.prepare(
        `INSERT INTO consents (id, customer_id, phone, purpose, granted_at, source_channel, source_business_account_id, source_sender_id, source_message_id, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET revoked_at = COALESCE(consents.revoked_at, excluded.revoked_at)`
      ).bind(`${value.id}:${evidence.sourceMessageId}`, value.customer.id, evidence.phone, evidence.purpose, evidence.grantedAt,
        evidence.sourceIdentity.channel, evidence.sourceIdentity.businessAccountId, evidence.sourceIdentity.senderId, evidence.sourceMessageId, evidence.revokedAt));
      return statements;
    };

    const session: ConversationSession = {
      state,

      async getProcessedTurn(providerMessageId: string): Promise<TurnResult | null> {
        const row = await db
          .prepare(
            `SELECT result_json
             FROM processed_turns
             WHERE channel = ? AND business_account_id = ? AND provider_message_id = ?`
          )
          .bind(identity.channel, identity.businessAccountId, providerMessageId)
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
        await db.batch([lease.fence(), ...checkpointStatements(updatedState, timestamp)]);
      },

      async complete(message: InboundMessage, finalState: ConversationState, result: TurnResult): Promise<void> {
        const timestamp = new Date().toISOString();
        const userMsgId = `msg_${crypto.randomUUID()}`;
        const assistantMsgId = `msg_${crypto.randomUUID()}`;

        await db.batch([
          lease.fence(),
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
          ...checkpointStatements(finalState, timestamp),
          // 5. Store turn result for replay
          db
            .prepare(
              `INSERT INTO processed_turns (channel, business_account_id, provider_message_id, conversation_id, result_json, processed_at)
               VALUES (?, ?, ?, ?, ?, ?)`
            )
            .bind(
              identity.channel,
              identity.businessAccountId,
              message.providerMessageId,
              finalState.id,
              JSON.stringify(result),
              timestamp
            ),
          db.prepare(`INSERT INTO outgoing_messages
            (id, conversation_id, channel, business_account_id, sender_id, source_message_id, text, last_inbound_at, available_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(assistantMsgId, finalState.id, identity.channel, identity.businessAccountId, identity.senderId,
              message.providerMessageId, result.reply, message.sentAt, timestamp, timestamp, timestamp),
          db.prepare("UPDATE message_inbox SET state = 'processed' WHERE channel = ? AND business_account_id = ? AND provider_message_id = ?")
            .bind(identity.channel, identity.businessAccountId, message.providerMessageId),
        ]);
      },
    };

    return work(session);
  }
}
