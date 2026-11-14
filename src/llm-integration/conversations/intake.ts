import type { ClassSchedule } from '../../../model.js';

export interface BookingIntake {
  date: string | null;
  time: string | null;
  phone: string | null;
  phoneUnavailable: boolean;
  updatedAt: string;
}

const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const weekdays = ['domingo|sunday', 'lunes|monday', 'martes|tuesday', 'miercoles|wednesday', 'jueves|thursday', 'viernes|friday', 'sabado|saturday'];
const months = ['enero|january', 'febrero|february', 'marzo|march', 'abril|april', 'mayo|may', 'junio|june', 'julio|july', 'agosto|august', 'septiembre|september', 'octubre|october', 'noviembre|november', 'diciembre|december'];

export function dallasDate(instant: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function dallasTime(instant: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));
}

function dateKey(year: number, month: number, day: number): string | null {
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day ? value.toISOString().slice(0, 10) : null;
}

function selectedDate(text: string, today: string): string | null | undefined {
  // General schedule questions and negations do not select one of the dates mentioned.
  if (/^(?:que (?:dias|horarios)|what (?:days|hours)|are you open)/.test(text)) return undefined;
  const dates: string[] = [];
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return dateKey(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const numeric = text.match(/\b(\d{1,2})[\/]([01]?\d)(?:[\/](20\d{2}))?\b/);
  if (numeric) return dateKey(Number(numeric[3] ?? today.slice(0, 4)), Number(numeric[2]), Number(numeric[1]));
  for (let month = 0; month < months.length; month++) {
    const match = text.match(new RegExp(`\\b(\\d{1,2})(?: de)? (${months[month]})(?: (?:de )?(20\\d{2}))?\\b`));
    if (match) return dateKey(Number(match[3] ?? today.slice(0, 4)), month + 1, Number(match[1]));
    const english = text.match(new RegExp(`\\b(${months[month]}) (\\d{1,2})(?:,? (20\\d{2}))?\\b`));
    if (english) return dateKey(Number(english[3] ?? today.slice(0, 4)), month + 1, Number(english[2]));
  }
  const base = new Date(`${today}T12:00:00Z`);
  const plusDays = (days: number) => new Date(base.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  const relative = text.replace(/\b(?:por la|en la|de la) manana\b/g, '').replace(/\b(?:manana o tarde|morning or afternoon)\b/g, '');
  if (/\b(?:pasado manana|day after tomorrow)\b/.test(relative)) dates.push(plusDays(2));
  else if (/\b(?:manana|tomorrow)\b/.test(relative)) dates.push(plusDays(1));
  else if (/\b(?:hoy|today)\b/.test(relative)) dates.push(today);
  for (let day = 0; day < weekdays.length; day++) {
    if (!new RegExp(`\\b(?:${weekdays[day]})\\b`).test(text)) continue;
    if (new RegExp(`\\b(?:no|not|excepto|except) (?:el )?(?:${weekdays[day]})\\b`).test(text)) return null;
    let offset = (day - base.getUTCDay() + 7) % 7;
    if (offset === 0 && /\b(?:proximo|next)\b/.test(text)) offset = 7;
    dates.push(plusDays(offset));
  }
  return dates.length ? (new Set(dates).size === 1 ? dates[0]! : null) : undefined;
}

/** Only customer text can select a day/hour. Assistant suggestions never enter this state. */
export function updateBookingIntake(previous: BookingIntake | undefined, text: string, now: string, schedule: ClassSchedule): BookingIntake {
  const today = dallasDate(now);
  const intake: BookingIntake = previous && Date.parse(now) - Date.parse(previous.updatedAt) < 24 * 60 * 60_000
    ? { ...previous } : { date: null, time: null, phone: null, phoneUnavailable: false, updatedAt: now };
  if (intake.date && intake.date < today) { intake.date = null; intake.time = null; }
  const value = normalize(text.trim());
  const date = selectedDate(value, today);
  if (date !== undefined) intake.date = date;
  const phone = text.match(/\+[1-9][\d ()-]{6,22}\d\b/)?.[0].replace(/[ ()-]/g, '');
  if (phone && /^\+[1-9]\d{7,14}$/.test(phone)) { intake.phone = phone; intake.phoneUnavailable = false; }
  else if (/\b(?:no (?:tengo|dispongo de) (?:un |numero de |numero para )?(?:telefono|numero|celular|movil|whatsapp)|(?:i )?(?:do not|don't) have (?:a )?(?:phone|number|whatsapp))\b/.test(value)) {
    intake.phone = null;
    intake.phoneUnavailable = true;
  }
  // A bare number might be a name, date or phone: require an explicit time expression.
  const match = value.match(/\b(?:a las?|at)\s+(\d{1,2})(?::([0-5]\d))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)?\b/)
    ?? value.match(/\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)\b/)
    ?? value.match(/\b(\d{1,2}):([0-5]\d)\b/);
  if (match) {
    const hour = Number(match[1]);
    const minute = match[2] ?? '00';
    const period = match[3]?.replace(/[.\s]/g, '');
    const time = (h: number) => `${String(h).padStart(2, '0')}:${minute}`;
    if (period && hour >= 1 && hour <= 12) intake.time = time(hour % 12 + (period === 'pm' ? 12 : 0));
    else if (!period && /^0\d$/.test(match[1]!)) intake.time = time(hour);
    else if (!period && hour >= 0 && hour <= 23) {
      const available = new Set(schedule.weekly.flatMap((day) => day.startTimes));
      const candidates = [...new Set([time(hour), ...(hour >= 1 && hour <= 11 ? [time(hour + 12)] : [])])].filter((candidate) => available.has(candidate));
      intake.time = candidates.length === 1 ? candidates[0]! : hour > 12 || hour === 0 ? time(hour) : null;
    }
  }
  intake.updatedAt = now;
  return intake;
}

export function isSelectedSlot(intake: BookingIntake, startsAt: string): boolean {
  return intake.date === dallasDate(startsAt) && intake.time === dallasTime(startsAt);
}

/** Dallas uses UTC-5/UTC-6; round-trip both to avoid assuming the current DST offset. */
export function selectedSlotInstant(intake: BookingIntake): string | null {
  if (!intake.date || !intake.time) return null;
  const wallTime = Date.parse(`${intake.date}T${intake.time}:00Z`);
  if (!Number.isFinite(wallTime)) return null;
  for (const offset of [5, 6]) {
    const instant = new Date(wallTime + offset * 3_600_000).toISOString();
    if (isSelectedSlot(intake, instant)) return instant;
  }
  return null;
}

export function dateHasClasses(date: string, schedule: ClassSchedule): boolean {
  const override = schedule.dateOverrides.find((item) => item.date === date);
  if (override) return override.startTimes.length > 0;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
  return schedule.weekly.some((item) => item.weekday === weekday && item.startTimes.length > 0);
}
