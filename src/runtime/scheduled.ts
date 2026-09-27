import type { Env } from '../types/env.js';
import { createServices } from './factory.js';

export async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  const services = createServices(env);
  await services.bookings.reconcilePendingOperations();
  await services.scheduler.processDueNotifications(new Date(event.scheduledTime).toISOString());
}
