import { GYM_TIME_ZONE, Instant, Language } from '../../model.js';
import { getGoogleCalendarAccessToken, GoogleServiceAccountCredentials } from './auth.js';

// Base32hex alphabet (0-9, a-v) compliant with Google Calendar Event ID specification
const BASE32HEX_ALPHABET = '0123456789abcdefghijklmnopqrstuv';

/**
 * Derives a deterministic, RFC 4648 Base32Hex Google Calendar Event ID from a booking ID.
 * Ensures that retried requests never create duplicate calendar events.
 */
export async function deriveCalendarEventId(bookingId: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`dwc_trial_${bookingId}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));

  // Convert first 20 bytes of SHA-256 hash to base32hex (32 characters)
  let bits = 0;
  let value = 0;
  let output = 'd'; // prefix 'd' is in [a-v]

  for (let i = 0; i < 20; i++) {
    value = (value << 8) | hashArray[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32HEX_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32HEX_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

export interface GoogleCalendarConfig extends GoogleServiceAccountCredentials {
  calendarId: string;
}

export interface CreateTrialEventInput {
  bookingId: string;
  customerName: string;
  whatsappPhone?: string | null;
  instagramHandle?: string | null;
  language?: Language;
  startsAt: Instant;
  endsAt: Instant;
  address?: string;
}

export interface UpdateTrialEventInput {
  startsAt: Instant;
  endsAt: Instant;
  summary?: string;
  description?: string;
}

export interface GoogleCalendarEvent {
  id: string;
  etag: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  updated: string;
}

export class GoogleCalendarClient {
  private calendarId: string;
  private credentials: GoogleServiceAccountCredentials;

  constructor(config: GoogleCalendarConfig) {
    this.calendarId = encodeURIComponent(config.calendarId);
    this.credentials = {
      clientEmail: config.clientEmail,
      privateKey: config.privateKey,
    };
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const accessToken = await getGoogleCalendarAccessToken(this.credentials);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${this.calendarId}${path}`;

    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${accessToken}`);
    headers.set('Content-Type', 'application/json');

    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
      const errorBody = await response.text();
      const error = new Error(`Google Calendar API error (${response.status} ${path}): ${errorBody}`);
      (error as any).status = response.status;
      throw error;
    }

    if (response.status === 204) {
      return null as T;
    }

    return (await response.json()) as T;
  }

  /**
   * Creates or idempotently upserts a prospect's trial event on Google Calendar.
   * Uses PUT with a deterministic eventId so retrying on timeout does not duplicate events.
   */
  async createTrialEvent(input: CreateTrialEventInput): Promise<GoogleCalendarEvent> {
    const eventId = await deriveCalendarEventId(input.bookingId);
    const address = input.address || '2640 Old Denton Rd, Carrollton, TX 75007';

    const description = [
      `Name: ${input.customerName}`,
      `WhatsApp: ${input.whatsappPhone || 'N/A'}`,
      `Instagram: ${input.instagramHandle || 'N/A'}`,
      `Language: ${input.language || 'es'}`,
      `Booking ID: ${input.bookingId}`,
    ].join('\n');

    const body = {
      id: eventId,
      summary: `Free trial — ${input.customerName}`,
      description,
      location: address,
      start: {
        dateTime: input.startsAt,
        timeZone: GYM_TIME_ZONE,
      },
      end: {
        dateTime: input.endsAt,
        timeZone: GYM_TIME_ZONE,
      },
      status: 'confirmed',
    };

    // Use import/upsert via PUT to guarantee idempotency across network retries
    return this.request<GoogleCalendarEvent>(`/events/${eventId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  /**
   * Reschedules an existing Google Calendar trial event.
   */
  async updateTrialEvent(
    eventId: string,
    input: UpdateTrialEventInput
  ): Promise<GoogleCalendarEvent> {
    const body: Record<string, unknown> = {
      start: {
        dateTime: input.startsAt,
        timeZone: GYM_TIME_ZONE,
      },
      end: {
        dateTime: input.endsAt,
        timeZone: GYM_TIME_ZONE,
      },
    };

    if (input.summary) body.summary = input.summary;
    if (input.description) body.description = input.description;

    return this.request<GoogleCalendarEvent>(`/events/${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  /**
   * Retrieves a single event to check current status or detect manual owner edits/deletions.
   */
  async getTrialEvent(eventId: string): Promise<GoogleCalendarEvent | null> {
    try {
      return await this.request<GoogleCalendarEvent>(`/events/${encodeURIComponent(eventId)}`, {
        method: 'GET',
      });
    } catch (err: any) {
      if (err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Cancels/deletes an event from the Google Calendar.
   */
  async deleteTrialEvent(eventId: string): Promise<void> {
    try {
      await this.request<void>(`/events/${encodeURIComponent(eventId)}`, {
        method: 'DELETE',
      });
    } catch (err: any) {
      if (err.status === 404 || err.status === 410) {
        // Already deleted or gone
        return;
      }
      throw err;
    }
  }

  /**
   * Lists upcoming trial events within a time range for reconciliation and cron reminder checks.
   */
  async listUpcomingTrialEvents(
    timeMin: Instant,
    timeMax: Instant
  ): Promise<GoogleCalendarEvent[]> {
    const query = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
    });

    const result = await this.request<{ items?: GoogleCalendarEvent[] }>(`/events?${query.toString()}`, {
      method: 'GET',
    });

    return result.items || [];
  }
}
