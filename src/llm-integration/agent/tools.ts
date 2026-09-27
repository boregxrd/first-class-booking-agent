import { z } from 'zod';
import type { ClassSchedule } from '../../../model.js';
import type { ModelTool } from './client.js';

export const proposalSchema = z.object({
  name: z.string().trim().min(1).max(100),
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
  startsAt: z.string().datetime(),
}).strict();

export type TrialProposal = z.infer<typeof proposalSchema>;

export const agentTools: ModelTool[] = [
  {
    type: 'function',
    function: {
      name: 'getClassSchedule',
      description: 'Read the authoritative class schedule. Does not check occupancy.',
      strict: true,
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'proposeTrial',
      description: 'ONLY when the customer wants to book and supplied name, international phone and chosen time. Prepares a summary for explicit customer confirmation; does NOT book.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name provided by the customer' },
          phone: { type: 'string', description: 'International E.164 phone, including + and country code' },
          startsAt: { type: 'string', description: 'Chosen class time converted from America/Chicago to UTC ISO 8601 ending in Z' },
        },
        required: ['name', 'phone', 'startsAt'],
        additionalProperties: false,
      },
    },
  },
];

/** The booking owner validates again; this prevents invalid confirmation proposals. */
export function isScheduledTime(startsAt: string, schedule: ClassSchedule, now: string): boolean {
  const timestamp = Date.parse(startsAt);
  const lead = timestamp - Date.parse(now);
  if (!Number.isFinite(lead) || lead <= 0 || lead < schedule.minimumLeadMinutes * 60_000
    || lead > schedule.bookingHorizonDays * 86_400_000) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  if (get('second') !== '00' || timestamp % 1000 !== 0) return false;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const time = `${get('hour')}:${get('minute')}`;
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday') ?? '') + 1;
  const override = schedule.dateOverrides.find((item) => item.date === date);
  return (override?.startTimes ?? schedule.weekly.find((item) => item.weekday === weekday)?.startTimes ?? []).includes(time);
}
