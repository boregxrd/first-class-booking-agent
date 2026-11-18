import type { ClassSchedule } from '../../../model.js';

const weekdays = ['domingo|sunday', 'lunes|monday', 'martes|tuesday', 'miercoles|wednesday', 'jueves|thursday', 'viernes|friday', 'sabado|saturday'];
const months = ['enero|january', 'febrero|february', 'marzo|march', 'abril|april', 'mayo|may', 'junio|june', 'julio|july', 'agosto|august', 'septiembre|september', 'octubre|october', 'noviembre|november', 'diciembre|december'];
const weekdayWords = weekdays.join('|'), monthWords = months.join('|');
const normalized = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export interface CalendarInputIssue { kind: 'weekday_mismatch' | 'relative_mismatch' | 'invalid_date' | 'ambiguous_dates'; date?: string; expectedDate?: string }
interface DateReference { date: string | null; start: number; end: number }

function dateKey(year: number, month: number, day: number): string | null {
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day ? value.toISOString().slice(0, 10) : null;
}
const dayIndex = (text: string) => weekdays.findIndex((pattern) => new RegExp(`^(?:${pattern})$`).test(text));
const monthIndex = (text: string) => months.findIndex((pattern) => new RegExp(`^(?:${pattern})$`).test(text)) + 1;

function references(text: string, today: string): DateReference[] {
  const result: DateReference[] = [];
  const add = (start: number, end: number, date: string | null) => {
    if (!result.some((ref) => start < ref.end && end > ref.start)) result.push({ start, end, date });
  };
  for (const match of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) add(match.index!, match.index! + match[0].length, dateKey(+match[1]!, +match[2]!, +match[3]!));
  for (const match of text.matchAll(/\b(\d{1,2})\/([01]?\d)(?:\/(20\d{2}))?\b/g)) add(match.index!, match.index! + match[0].length,
    dateKey(Number(match[3] ?? today.slice(0, 4)), +match[2]!, +match[1]!));
  const named = new RegExp(`\\b(?:(?<day>\\d{1,2})(?: de)? (?<month>${monthWords})(?: (?:de )?(?<year>20\\d{2}))?|(?<emonth>${monthWords}) (?<eday>\\d{1,2})(?:,? (?<eyear>20\\d{2}))?)\\b`, 'g');
  for (const match of text.matchAll(named)) {
    const value = match.groups!;
    add(match.index!, match.index! + match[0].length, dateKey(Number(value.year ?? value.eyear ?? today.slice(0, 4)), monthIndex(value.month ?? value.emonth!), Number(value.day ?? value.eday)));
  }
  const bare = new RegExp(`\\b(?:${weekdayWords})\\s*,?\\s+(\\d{1,2})\\b(?!:)`, 'g');
  for (const match of text.matchAll(bare)) {
    const start = match.index! + match[0].lastIndexOf(match[1]!);
    if (/^\s*(?:a\.?\s*m\.?|p\.?\s*m\.?|por la|de la|en la)\b/.test(text.slice(start + match[1]!.length))) continue;
    add(start, start + match[1]!.length, dateKey(Number(today.slice(0, 4)), Number(today.slice(5, 7)), +match[1]!));
  }
  return result.sort((a, b) => a.start - b.start);
}

/** Parse adjacent weekday/date claims without treating a list of weekly opening days as a claim. */
export function calendarInputReference(content: string, today: string): { date: string | null; issue?: CalendarInputIssue } | undefined {
  const text = normalized(content), refs = references(text, today), dates: string[] = [];
  for (const ref of refs) {
    const before = text.slice(Math.max(0, ref.start - 90), ref.start), after = text.slice(ref.end);
    const prefix = before.match(new RegExp(`\\b(${weekdayWords})\\s*,?\\s*$`));
    if (prefix && new RegExp(`\\b(?:no|not) (?:el )?(?:${weekdayWords})\\s*,?\\s*$`).test(before)) continue;
    if (!ref.date) return { date: null, issue: { kind: 'invalid_date' } };
    const relative = before.match(new RegExp(`\\b(hoy|manana|today|tomorrow)(?: es)?\\s*,?\\s*(?:(?:${weekdayWords})\\s*,?\\s*)?$`));
    if (relative) {
      const expected = ['manana', 'tomorrow'].includes(relative[1]!) ? new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : today;
      if (expected !== ref.date) return { date: null, issue: { kind: 'relative_mismatch', date: ref.date, expectedDate: expected } };
    }
    const suffix = after.match(new RegExp(`^\\s*(?:es|cae(?: en)?|is|falls on)\\s+(${weekdayWords})\\b`));
    const actual = new Date(`${ref.date}T12:00:00Z`).getUTCDay();
    if ((prefix && dayIndex(prefix[1]!) !== actual) || (suffix && dayIndex(suffix[1]!) !== actual)) {
      return { date: null, issue: { kind: 'weekday_mismatch', date: ref.date } };
    }
    dates.push(ref.date);
  }
  if (!refs.length) return undefined;
  return new Set(dates).size === 1 ? { date: dates[0]! } : { date: null, issue: { kind: 'ambiguous_dates' } };
}

export function scheduledTimes(date: string, schedule: ClassSchedule): string[] {
  const override = schedule.dateOverrides.find((item) => item.date === date);
  if (override) return [...override.startTimes];
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
  return [...(schedule.weekly.find((item) => item.weekday === weekday)?.startTimes ?? [])];
}
export function calendarFacts(date: string, schedule: ClassSchedule) {
  const instant = new Date(`${date}T12:00:00Z`), times = scheduledTimes(date, schedule);
  return { date, weekdayEs: new Intl.DateTimeFormat('es', { timeZone: 'UTC', weekday: 'long' }).format(instant),
    weekdayEn: new Intl.DateTimeFormat('en', { timeZone: 'UTC', weekday: 'long' }).format(instant), hasClasses: times.length > 0, scheduledStartTimes: times };
}
export function localDateDescription(date: string, language: 'es' | 'en') {
  return new Intl.DateTimeFormat(language === 'es' ? 'es-US' : 'en-US', { timeZone: 'UTC', dateStyle: 'full' }).format(new Date(`${date}T12:00:00Z`));
}
export function calendarIssueReply(issue: CalendarInputIssue, today: string, language: 'es' | 'en') {
  if (!issue.date) return language === 'es' ? 'Necesito aclarar la fecha: ¿qué día, mes y año quieres para tu clase?' : 'Please clarify the date: which day, month and year would you like?';
  const actual = localDateDescription(issue.date, language);
  return language === 'es'
    ? `${issue.kind === 'relative_mismatch' ? `Hoy en Dallas es ${localDateDescription(today, language)}. ` : ''}La fecha que indicas cae en ${actual}. ¿Qué fecha exacta prefieres?`
    : `${issue.kind === 'relative_mismatch' ? `Today in Dallas is ${localDateDescription(today, language)}. ` : ''}The date you gave is ${actual}. Which exact date would you prefer?`;
}

/** Reject factual calendar contradictions in model prose; availability comes only from the schedule. */
export function calendarReplyCorrection(reply: string, today: string, schedule: ClassSchedule, selectedDate: string | null): string | null {
  const reference = calendarInputReference(reply, today);
  if (reference?.issue && reference.issue.kind !== 'ambiguous_dates') {
    return `Tu respuesta contiene una contradicción de calendario. Usa estos hechos calculados, sin recalcular el día: ${JSON.stringify(reference.issue.date ? calendarFacts(reference.issue.date, schedule) : { today, issue: reference.issue.kind })}. Corrige la respuesta o llama la herramienta de propuesta si corresponde; no inventes otra fecha.`;
  }
  for (const sentence of reply.split(/[;.!?]\s+|\n/)) {
    if (!/\b(?:no (?:hay|tenemos|ofrecemos) clases|no classes|no scheduled classes|closed)\b/i.test(sentence)) continue;
    const dates = references(normalized(sentence), today).map((ref) => ref.date).filter((date): date is string => Boolean(date));
    if (!dates.length && selectedDate && /\b(?:ese dia|that day)\b/.test(normalized(sentence))) dates.push(selectedDate);
    for (const date of dates) {
      const facts = calendarFacts(date, schedule), actual = new Date(`${date}T12:00:00Z`).getUTCDay();
      const mentionsAnotherDay = weekdays.some((pattern, index) => index !== actual && new RegExp(`\\b(?:${pattern})(?:s)?\\b`).test(normalized(sentence)));
      if (facts.hasClasses && !mentionsAnotherDay) return `No afirmes que no hay clases ese día: el horario autoritativo sí las programa. Hechos calculados: ${JSON.stringify(facts)}. Responde con estos datos y pide solo lo que falte, sin inventar reservas ni ocupación.`;
    }
  }
  return null;
}
