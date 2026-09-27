import type { Instant } from '../../model.js';
import { getGoogleCalendarAccessToken, type GoogleServiceAccountCredentials } from './auth.js';

export interface GoogleCalendarConfig extends GoogleServiceAccountCredentials { calendarId: string }

export interface GoogleCalendarEvent {
  id: string;
  etag: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  summary: string;
  description?: string;
  start: { dateTime: Instant; timeZone?: string };
  end: { dateTime: Instant; timeZone?: string };
  extendedProperties?: { private?: Record<string, string> };
}

export type RosterEventBody = Omit<GoogleCalendarEvent, 'etag'> & { location: string };

/** Narrow transport contract: roster creation/replacement, never per-person event deletion. */
export interface RosterCalendar {
  readonly configuredCalendarId: string;
  getEvent(eventId: string): Promise<GoogleCalendarEvent | null>;
  insertEvent(body: RosterEventBody): Promise<GoogleCalendarEvent>;
  replaceRoster(body: RosterEventBody, etag: string): Promise<GoogleCalendarEvent>;
}

export class CalendarApiError extends Error {
  constructor(readonly status: number) { super(`Google Calendar request failed (HTTP ${status})`); }
}

export class GoogleCalendarClient implements RosterCalendar {
  readonly configuredCalendarId: string;
  constructor(private readonly config: GoogleCalendarConfig) {
    this.configuredCalendarId = config.calendarId;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const token = await getGoogleCalendarAccessToken(this.config);
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('Content-Type', 'application/json');
    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.config.calendarId)}${path}`, {
      ...options, headers, signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new CalendarApiError(response.status);
    return await response.json() as T;
  }

  async getEvent(eventId: string): Promise<GoogleCalendarEvent | null> {
    try { return await this.request<GoogleCalendarEvent>(`/events/${encodeURIComponent(eventId)}`); }
    catch (error) {
      if (error instanceof CalendarApiError && error.status === 404) return null;
      throw error;
    }
  }

  insertEvent(body: RosterEventBody): Promise<GoogleCalendarEvent> {
    return this.request('/events', { method: 'POST', body: JSON.stringify(body) });
  }

  replaceRoster(body: RosterEventBody, etag: string): Promise<GoogleCalendarEvent> {
    return this.request(`/events/${encodeURIComponent(body.id)}`, {
      method: 'PATCH', headers: { 'If-Match': etag }, body: JSON.stringify(body),
    });
  }
}
