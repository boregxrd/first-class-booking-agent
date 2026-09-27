/**
 * Shared domain contracts for the two workstreams in ROADMAP.md.
 * These define planned interfaces, not runtime validators or database migrations.
 * Validate all external inputs before constructing these values.
 */
export type Channel = 'instagram' | 'whatsapp';
export type Language = 'es' | 'en';
/** RFC 3339 UTC instant, e.g. 2026-09-28T13:00:00Z. */
export type Instant = string;
/** YYYY-MM-DD in the gym's timezone. */
export type LocalDate = string;
/** HH:mm, 24-hour local time. */
export type LocalTime = string;
/** International phone number with leading +; normalize and validate at runtime. */
export type E164Phone = string;
export const GYM_TIME_ZONE = 'America/Chicago' as const;

export interface ChannelIdentity {
  channel: Channel;
  /** Instagram business account ID or WhatsApp phone-number ID. */
  businessAccountId: string;
  /** Provider-scoped sender ID; not an application customer ID. */
  senderId: string;
}

/** Normalized text only. Media/status/echo handling belongs in channel adapters. */
export interface InboundMessage {
  identity: ChannelIdentity;
  providerMessageId: string;
  sentAt: Instant;
  receivedAt: Instant;
  text: string;
}

export interface ConsentEvidence {
  phone: E164Phone;
  purpose: 'trial_confirmation_and_reminders';
  grantedAt: Instant;
  sourceIdentity: ChannelIdentity;
  sourceMessageId: string;
  revokedAt: Instant | null;
}

export interface Customer {
  id: string;
  name: string | null;
  whatsappPhone: E164Phone | null;
  instagramHandle?: string | null;
  language: Language;
  whatsappConsent: ConsentEvidence | null;
  createdAt: Instant;
  updatedAt: Instant;
}

export interface Conversation {
  id: string;
  customerId: string;
  identity: ChannelIdentity;
  selectedStartsAt: Instant | null;
  /** Increment on committed turns; use serialization, not only this counter. */
  revision: number;
  updatedAt: Instant;
}

export interface ClassSchedule {
  timeZone: typeof GYM_TIME_ZONE;
  /** ISO weekday: Monday = 1, Sunday = 7. Times are owner-approved. */
  weekly: Array<{
    weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7;
    startTimes: LocalTime[];
  }>;
  durationMinutes: number;
  /** Replaces that date's weekly times. Empty startTimes means closed. */
  dateOverrides: Array<{ date: LocalDate; startTimes: LocalTime[] }>;
  minimumLeadMinutes: number;
  bookingHorizonDays: number;
}

export interface TrialBooking {
  id: string;
  customerId: string;
  startsAt: Instant;
  endsAt: Instant;
  timeZone: typeof GYM_TIME_ZONE;
  /** Time passing does not prove attendance or membership conversion. */
  status: 'pending' | 'confirmed' | 'cancelled' | 'elapsed' | 'failed';
  revision: number;
  /** Shared hourly roster event; never delete/move it to change a single booking. */
  calendar: { calendarId: string; eventId: string; etag: string | null } | null;
  createdAt: Instant;
  updatedAt: Instant;
}

/** Supplied by application code, never exposed as model tool arguments. */
export interface BookingContext {
  customerId: string;
  conversationId: string;
  sourceMessageId: string;
  requestedAt: Instant;
}

export interface BookingMutationContext extends BookingContext {
  /** Stable across retries of the same logical operation, scoped to customer. */
  operationKey: string;
  /** Message where the customer approved this create/change/cancel action. */
  confirmationMessageId: string;
}

export interface BookTrialInput {
  startsAt: Instant;
}

export interface RescheduleTrialInput {
  bookingId: string;
  startsAt: Instant;
  expectedRevision: number;
}

export interface CancelTrialInput {
  bookingId: string;
  expectedRevision: number;
}

export type BookingErrorCode =
  | 'invalid_schedule'
  | 'missing_customer_details'
  | 'not_found'
  | 'already_booked'
  | 'trial_not_eligible'
  | 'revision_conflict'
  | 'idempotency_conflict'
  | 'dependency_unavailable';

export type BookingResult =
  | { status: 'succeeded'; booking: TrialBooking }
  | { status: 'pending'; operationKey: string; bookingId: string }
  | { status: 'failed'; code: BookingErrorCode; message: string; retryable: boolean };

/**
 * Implemented by B; consumed by A's validated agent tools.
 * Load customer details/consent from A's persisted customer store, not the LLM.
 * Scope all reads/writes to context.customerId; hide foreign booking existence.
 * A successful create/reschedule means the Calendar event is synchronized.
 * Pending results need reconciliation and MUST NOT produce a confirmation.
 * Replay operationKey with the same arguments to recover an existing result;
 * reject reuse with different arguments. No capacity checks are required.
 */
export interface BookingService {
  getClassSchedule(): Promise<ClassSchedule>;
  getCurrentBooking(context: BookingContext): Promise<TrialBooking | null>;
  getBooking(context: BookingContext, bookingId: string): Promise<TrialBooking | null>;
  bookTrial(context: BookingMutationContext, input: BookTrialInput): Promise<BookingResult>;
  rescheduleTrial(context: BookingMutationContext, input: RescheduleTrialInput): Promise<BookingResult>;
  cancelTrial(context: BookingMutationContext, input: CancelTrialInput): Promise<BookingResult>;
}

export type NotificationKind = 'confirmation' | 'reminder';

/** B persists jobs; migrations must enforce booking/revision/kind uniqueness. */
export interface NotificationJob {
  id: string;
  bookingId: string;
  bookingRevision: number;
  kind: NotificationKind;
  scheduledAt: Instant;
  state: 'pending' | 'leased' | 'sending' | 'accepted' | 'unknown' | 'failed' | 'cancelled';
  attempts: number;
  leaseToken: string | null;
  leaseExpiresAt: Instant | null;
  providerMessageId: string | null;
  lastErrorCode: string | null;
}

/** MVP templates use ordered body text parameters; B selects approved templates. */
export interface WhatsAppTemplateRequest {
  notificationJobId: string;
  to: E164Phone;
  templateName: string;
  /** Exact Meta-approved language code, e.g. es or en_US. */
  languageCode: string;
  bodyParameters: string[];
}

export type TemplateSendResult =
  | { status: 'accepted'; providerMessageId: string }
  | { status: 'rejected'; code: string; retryable: boolean }
  /** Request may have succeeded remotely; do not blindly retry. */
  | { status: 'unknown'; reason: string };

/** A implements transport; B owns job claiming, consent checks and retry policy. */
export interface WhatsAppTemplateSender {
  sendTemplate(request: WhatsAppTemplateRequest): Promise<TemplateSendResult>;
}

export interface NotificationDeliveryUpdate {
  businessAccountId: string;
  providerMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  occurredAt: Instant;
  errorCode?: string;
  correlationId?: string;
}

/** B implements persistence/reconciliation; A routes verified Meta callbacks. */
export interface NotificationStatusHandler {
  handleDeliveryUpdate(update: NotificationDeliveryUpdate): Promise<void>;
}
