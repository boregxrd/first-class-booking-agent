import { z } from 'zod';
import type { ClassSchedule } from '../../../model.js';
import type { ModelTool } from './client.js';
import { validateBookingSlot } from '../../gym/schedule.js';

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
  return validateBookingSlot(startsAt, now, schedule).valid;
}
