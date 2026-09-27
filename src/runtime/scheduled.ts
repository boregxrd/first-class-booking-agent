import type { Env } from '../types/env.js';
import { createServices } from './factory.js';
import { reconcileCalendarSlots } from '../calendar/reconcile.js';
import { drainInbox, resumeCompletedActions } from '../llm-integration/runtime/inbox.js';
import { dispatchOutbox } from '../llm-integration/runtime/outbox.js';
import { alert, resolveAlert } from '../llm-integration/runtime/persistence.js';
import { maintainState } from './maintenance.js';
import { recoverDeliveries } from '../llm-integration/runtime/delivery.js';

export async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  if (!env.DB) throw new Error('D1 binding DB is required');
  const services = createServices(env);
  const now = new Date(event.scheduledTime).toISOString();
  const tasks: Array<[string, () => Promise<unknown>]> = [
    ['delivery-recovery', async () => { await recoverDeliveries(env.DB!, 'outgoing_messages', now); await recoverDeliveries(env.DB!, 'notification_jobs', now); }],
    ['bookings', () => services.bookings.reconcilePendingOperations(1)],
    ['calendar', () => services.calendarClient ? reconcileCalendarSlots(env.DB!, services.calendarClient, now) : Promise.resolve()],
    ['receipts', () => services.statusHandler.reconcileStoredReceipts()],
  ];
  if (env.META_MESSAGING_MODE === 'live' || env.META_MESSAGING_MODE === 'test') tasks.push(
    ['inbox', () => drainInbox(env.DB!, (message) => services.processor(message), 1, now)],
    ['completed-actions', () => resumeCompletedActions(env.DB!, (message) => services.processor(message), now)],
    ['outbox', () => dispatchOutbox(env.DB!, services.textSender, now)],
  );
  if (env.WHATSAPP_NOTIFICATIONS_ENABLED === 'true') tasks.push(['notifications', () => services.scheduler.processDueNotifications(now)]);
  tasks.push(['maintenance', () => maintainState(env.DB!, env, now)]);
  for (const [name, run] of tasks) {
    try { await run(); await resolveAlert(env.DB, 'scheduled_task_failed', name); }
    catch { await alert(env.DB, 'scheduled_task_failed', name, 'Inspect configuration and retry; no customer data logged', now); }
  }
}
