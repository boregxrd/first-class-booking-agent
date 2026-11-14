import type { BookingMutationContext, ChannelIdentity, Customer, InboundMessage } from '../../../model.js';
import type { TrialProposal } from '../agent/tools.js';
import type { BookingIntake } from './intake.js';

export interface ConversationState {
  id: string;
  customer: Customer;
  /** Optional lookup cache; a display name is not a confirmed customer name. */
  instagramProfile?: { name: string | null; username: string | null; checkedAt: string; pendingName?: string | null; pendingNameExpiresAt?: string | null };
  bookingIntake?: BookingIntake;
  /** Complete text turns only, bounded by the processor. */
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  proposal: (({ action: 'book'; intakeVerified?: boolean } & TrialProposal) | { action: 'reschedule' | 'cancel'; bookingId: string; expectedRevision: number; startsAt: string }) & { sourceMessageId: string; expiresAt: string } | null;
  bookingOperation: { context: BookingMutationContext; startsAt: string; action: 'book' | 'reschedule' | 'cancel'; bookingId?: string; expectedRevision?: number } | null;
}

export interface TurnResult {
  reply: string;
  bookingStatus: 'none' | 'awaiting_confirmation' | 'confirmed' | 'cancelled' | 'pending' | 'failed';
  usage: { inputTokens: number; outputTokens: number };
}

export interface ConversationSession {
  state: ConversationState;
  getProcessedTurn(providerMessageId: string): Promise<TurnResult | null>;
  /** Durable checkpoint; also persist customer fields for BookingService to read. */
  save(state: ConversationState): Promise<void>;
  /** Atomically store state, dedup result and a pending reply for the outbound sender. */
  complete(message: InboundMessage, state: ConversationState, result: TurnResult): Promise<void>;
}

/**
 * Production adapter must serialize by the full channel/account/sender identity,
 * recover expired leases, and persist checkpoints/results (not process memory).
 * It must not hold a SQL transaction across the callback's external API requests.
 */
export interface ConversationStore {
  withConversation<T>(identity: ChannelIdentity, work: (session: ConversationSession) => Promise<T>): Promise<T>;
}
