import { GYM_TIME_ZONE, Instant } from '../../model.js';
import { deriveCalendarEventId, GoogleCalendarClient, GoogleCalendarEvent } from './client.js';

export interface ProspectSlotEntry {
  firstName: string;
  phone?: string | null;
  instagramHandle?: string | null;
}

export interface AddProspectToSlotInput {
  /** ISO string of the slot start time (e.g., "2026-09-28T08:00:00-05:00" or UTC "2026-09-28T13:00:00Z") */
  startsAt: Instant;
  prospect: ProspectSlotEntry;
  address?: string;
}

export interface SlotRosterResult {
  event: GoogleCalendarEvent;
  isNewEvent: boolean;
  totalAttendees: number;
}

/**
 * Derives a deterministic event ID for a recurring class time slot (e.g. 2026-09-28T08:00).
 */
export async function deriveSlotRosterEventId(startsAt: Instant): Promise<string> {
  const date = new Date(startsAt);
  // Format as UTC timestamp string for stable slot key
  const slotKey = `slot_${date.toISOString().replace(/[^a-zA-Z0-9]/g, '')}`;
  return deriveCalendarEventId(slotKey);
}

/**
 * Formats a single attendee line in the roster description.
 */
function formatAttendeeLine(entry: ProspectSlotEntry): string {
  const contact = entry.phone ? `Phone: ${entry.phone}` : entry.instagramHandle ? `IG: ${entry.instagramHandle}` : 'N/A';
  return `- ${entry.firstName} (${contact})`;
}

/**
 * Calculates end time exactly 1 hour (hard-coded) after start time.
 */
export function calculateOneHourEndTime(startsAt: Instant): Instant {
  const startDate = new Date(startsAt);
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000); // 1 hour in milliseconds
  return endDate.toISOString();
}

/**
 * Verifies if an event exists for the specified Google Calendar slot.
 * - If it does NOT exist: Creates a new event with 1-hour duration and initializes the attendee list.
 * - If it DOES exist: Modifies the existing event description to add the new user.
 */
export async function addProspectToSlotRoster(
  client: GoogleCalendarClient,
  input: AddProspectToSlotInput
): Promise<SlotRosterResult> {
  const { startsAt, prospect, address = '2640 Old Denton Rd, Carrollton, TX 75007' } = input;
  const endsAt = calculateOneHourEndTime(startsAt);
  const slotEventId = await deriveSlotRosterEventId(startsAt);

  // 1. Check if the slot event already exists by deterministic slot ID
  let existingEvent: GoogleCalendarEvent | null = await client.getTrialEvent(slotEventId);

  // Fallback: If not found by deterministic ID, check by time range (within +/- 1 minute window)
  if (!existingEvent) {
    const startDate = new Date(startsAt);
    const windowMin = new Date(startDate.getTime() - 60 * 1000).toISOString();
    const windowMax = new Date(startDate.getTime() + 60 * 1000).toISOString();

    const candidates = await client.listUpcomingTrialEvents(windowMin, windowMax);
    const matched = candidates.find(
      (e) => e.status !== 'cancelled' && Math.abs(new Date(e.start.dateTime).getTime() - startDate.getTime()) < 60000
    );
    if (matched) {
      existingEvent = matched;
    }
  }

  const newAttendeeLine = formatAttendeeLine(prospect);

  // 2. If event DOES NOT exist -> Create new event
  if (!existingEvent) {
    const description = ['Attendees (1):', newAttendeeLine].join('\n');

    const newEvent = await client.createTrialEvent({
      bookingId: `slot_${new Date(startsAt).toISOString()}`,
      customerName: `Class Roster (${prospect.firstName})`,
      whatsappPhone: prospect.phone,
      instagramHandle: prospect.instagramHandle,
      startsAt,
      endsAt,
      address,
    });

    // Update with exact roster header & description
    const updated = await client.updateTrialEvent(newEvent.id, {
      startsAt,
      endsAt,
      summary: `DWC Class — ${prospect.firstName}`,
      description,
    });

    return {
      event: updated,
      isNewEvent: true,
      totalAttendees: 1,
    };
  }

  // 3. If event DOES exist -> Append new attendee to description
  const currentDescription = existingEvent.description || 'Attendees (0):';
  const lines = currentDescription.split('\n');

  // Prevent duplicate entry if the exact same attendee info is already listed
  let updatedDescription: string;
  let attendeeCount = 1;

  if (currentDescription.includes(newAttendeeLine)) {
    // Already in roster
    updatedDescription = currentDescription;
    const match = currentDescription.match(/Attendees \((\d+)\)/);
    attendeeCount = match ? parseInt(match[1], 10) : 1;
  } else {
    // Add new attendee
    const attendeeLines = lines.filter((line) => line.trim().startsWith('-'));
    attendeeCount = attendeeLines.length + 1;

    const header = `Attendees (${attendeeCount}):`;
    const remainingLines = lines.filter((l) => !l.startsWith('Attendees ('));
    updatedDescription = [header, ...remainingLines, newAttendeeLine].join('\n');
  }

  const updatedEvent = await client.updateTrialEvent(existingEvent.id, {
    startsAt: existingEvent.start.dateTime,
    endsAt: existingEvent.end.dateTime,
    summary: `DWC Class (${attendeeCount} attendees)`,
    description: updatedDescription,
  });

  return {
    event: updatedEvent,
    isNewEvent: false,
    totalAttendees: attendeeCount,
  };
}
