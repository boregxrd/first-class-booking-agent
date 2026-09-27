import { ClassSchedule, GYM_TIME_ZONE, Instant, LocalDate, LocalTime } from '../../model.js';
import { gymContext } from '../llm-integration/gym-context.js';

export const AUTHORITATIVE_SCHEDULE: ClassSchedule = {
  timeZone: GYM_TIME_ZONE,
  weekly: gymContext.advertisedSchedule,
  durationMinutes: gymContext.classDurationMinutes,
  dateOverrides: [],
  minimumLeadMinutes: 60,
  bookingHorizonDays: 14,
};

export interface SlotValidationResult {
  valid: boolean;
  reason?: string;
  localDate?: LocalDate;
  localTime?: LocalTime;
  startsAtUtc?: Instant;
  endsAtUtc?: Instant;
}

/**
 * Validates whether a requested UTC instant matches an available class slot in America/Chicago.
 */
export function validateBookingSlot(
  startsAtInstant: Instant,
  nowInstant: Instant = new Date().toISOString(),
  schedule: ClassSchedule = AUTHORITATIVE_SCHEDULE
): SlotValidationResult {
  const requestedDate = new Date(startsAtInstant);
  const nowDate = new Date(nowInstant);

  if (isNaN(requestedDate.getTime())) {
    return { valid: false, reason: 'Invalid date timestamp format.' };
  }

  // 1. Lead time check (minimum 60 minutes in advance)
  const minLeadMs = schedule.minimumLeadMinutes * 60 * 1000;
  if (requestedDate.getTime() < nowDate.getTime() + minLeadMs) {
    return { valid: false, reason: 'Cannot book past classes or classes starting in less than 1 hour.' };
  }

  // 2. Booking horizon check (max 14 days in advance)
  const maxHorizonMs = schedule.bookingHorizonDays * 24 * 60 * 60 * 1000;
  if (requestedDate.getTime() > nowDate.getTime() + maxHorizonMs) {
    return { valid: false, reason: `Bookings can only be scheduled up to ${schedule.bookingHorizonDays} days in advance.` };
  }

  // Convert requested instant to America/Chicago local date and time
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });

  const parts = formatter.formatToParts(requestedDate);
  const partMap: Record<string, string> = {};
  for (const part of parts) {
    partMap[part.type] = part.value;
  }

  const year = partMap.year;
  const month = partMap.month;
  const day = partMap.day;
  const hour = partMap.hour === '24' ? '00' : partMap.hour;
  const minute = partMap.minute;
  const weekdayStr = partMap.weekday;

  const localDate: LocalDate = `${year}-${month}-${day}`;
  const localTime: LocalTime = `${hour}:${minute}`;

  // Map weekday string to ISO number (Mon=1 ... Sun=7)
  const weekdayMap: Record<string, 1 | 2 | 3 | 4 | 5 | 6 | 7> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  const weekdayNum = weekdayMap[weekdayStr];

  // 3. Check date overrides (holidays / closures)
  const override = schedule.dateOverrides.find((o) => o.date === localDate);
  if (override) {
    if (override.startTimes.length === 0) {
      return { valid: false, reason: `The studio is closed on ${localDate}.` };
    }
    if (!override.startTimes.includes(localTime)) {
      return {
        valid: false,
        reason: `On ${localDate}, classes are only available at: ${override.startTimes.join(', ')}.`,
      };
    }
  } else {
    // 4. Check regular weekly schedule
    const weeklyConfig = schedule.weekly.find((w) => w.weekday === weekdayNum);
    if (!weeklyConfig || !weeklyConfig.startTimes.includes(localTime)) {
      return {
        valid: false,
        reason: `No class is scheduled at ${localTime} on ${weekdayStr} (${localDate}).`,
      };
    }
  }

  const durationMs = schedule.durationMinutes * 60 * 1000;
  const endsAtUtc = new Date(requestedDate.getTime() + durationMs).toISOString();

  return {
    valid: true,
    localDate,
    localTime,
    startsAtUtc: requestedDate.toISOString(),
    endsAtUtc,
  };
}
