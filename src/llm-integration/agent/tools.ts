import { z } from 'zod';
import type { ClassSchedule } from '../../../model.js';
import type { ModelTool } from './client.js';
import { validateBookingSlot } from '../../gym/schedule.js';

export const proposalSchema = z.object({
  name: z.string().trim().min(1).max(100),
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/).nullable().default(null),
  instagramHandle: z.string().regex(/^@?[a-zA-Z0-9._]{1,30}$/).nullable().default(null),
  startsAt: z.string().datetime(),
}).strict().refine((value) => Boolean(value.phone || value.instagramHandle), 'A phone number or Instagram handle is required');

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
      description: 'ONLY when the customer wants to book and supplied name, phone or Instagram handle, and chosen time. Prepares an explicit confirmation summary; does NOT book.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name provided by the customer' },
          phone: { type: ['string', 'null'], description: 'International E.164 phone, including + and country code, or null when using Instagram contact only' },
          instagramHandle: { type: ['string', 'null'], description: 'Actual Instagram username provided by the customer; never substitute a scoped numeric sender ID' },
          startsAt: { type: 'string', description: 'Chosen class time converted from America/Chicago to UTC ISO 8601 ending in Z' },
        },
        required: ['name', 'phone', 'instagramHandle', 'startsAt'],
        additionalProperties: false,
      },
    },
  },
];

/** The booking owner validates again; this prevents invalid confirmation proposals. */
export function isScheduledTime(startsAt: string, schedule: ClassSchedule, now: string): boolean {
  return validateBookingSlot(startsAt, now, schedule).valid;
}
