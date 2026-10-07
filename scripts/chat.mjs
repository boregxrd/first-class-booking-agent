import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import assert from 'node:assert/strict';

const tokenPath = new URL('../.direct-chat-token', import.meta.url);
const baseUrl = process.env.DIRECT_CHAT_URL ?? 'https://first-class-booking-agent.dallaswellnessclubweb.workers.dev';
let token = process.env.DIRECT_CHAT_TOKEN;
if (!token) token = await readFile(tokenPath, 'utf8').then((value) => value.trim()).catch(() => null);

if (process.argv.includes('--setup')) {
  if (!token) {
    token = randomBytes(32).toString('hex');
    await writeFile(tokenPath, token, { mode: 0o600, flag: 'wx' });
  }
  const result = spawnSync('npx', ['wrangler', 'secret', 'put', 'DIRECT_CHAT_TOKEN'], {
    cwd: new URL('../', import.meta.url), input: token, stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log('Direct-chat token installed. Run npm run deploy, then npm run chat.');
  process.exit(0);
}
if (!token) throw new Error('Run npm run chat:setup first, or set DIRECT_CHAT_TOKEN.');

async function send(conversationId, text, messageId = randomUUID()) {
  const response = await fetch(new URL('/test/chat', baseUrl), {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, messageId, text }), signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)} (conversation ${conversationId}, message ${messageId}; reuse these IDs to retry)`);
  console.log(`\nAgent: ${body.reply}\n[${body.bookingStatus}; model tokens: ${body.usage.inputTokens}/${body.usage.outputTokens}]`);
  return body;
}

// Select valid future weekday morning classes, including Dallas DST conversion.
function futureSlots() {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
  const slots = [];
  const start = Math.ceil((Date.now() + 24 * 3600_000) / 3600_000) * 3600_000;
  for (let time = start; slots.length < 2; time += 3600_000) {
    const parts = Object.fromEntries(formatter.formatToParts(time).map((part) => [part.type, part.value]));
    if (!['Sat', 'Sun'].includes(parts.weekday) && ['09', '10'].includes(parts.hour)) slots.push(new Date(time).toISOString());
  }
  return slots;
}

if (process.argv.includes('--test')) {
  const suffix = randomUUID().slice(0, 8);
  const ana = `live-ana-${suffix}`, sofia = `live-sofia-${suffix}`;
  const anaName = `Integration Ana ${suffix}`, sofiaName = `Integration Sofia ${suffix}`;
  const [firstSlot, secondSlot] = futureSlots();
  console.log(`LIVE TEST: real bookings in the configured Calendar. Conversations: ${ana}, ${sofia}. Slots: ${firstSlot}, ${secondSlot}.`);
  async function propose(id, text) {
    let turn = await send(id, text);
    for (let attempt = 0; turn.bookingStatus === 'none' && attempt < 3; attempt++) {
      turn = await send(id, `Yes, please prepare the proposal for my review using the details I just provided. ${text}`);
    }
    assert.equal(turn.bookingStatus, 'awaiting_confirmation', 'Expected an explicit booking/change proposal');
    assert.ok(turn.usage.inputTokens > 0, 'Proposal must use the real model');
    return turn;
  }
  async function confirm(id, status) {
    const messageId = randomUUID();
    const turn = await send(id, 'yes confirm', messageId);
    assert.equal(turn.bookingStatus, status);
    const replay = await send(id, 'yes confirm', messageId);
    assert.equal(replay.reply, turn.reply, 'Retry should replay the stored turn');
    assert.equal(replay.booking.id, turn.booking.id);
    assert.equal(replay.booking.revision, turn.booking.revision, 'Retry must not mutate twice');
    return turn;
  }
  await propose(ana, `Hello! My name is ${anaName}, my Instagram handle is @testana${suffix}. Book my free trial at exactly ${firstSlot} (UTC; convert to Dallas time). Use only my Instagram contact; I do not want WhatsApp messages.`);
  const first = await confirm(ana, 'confirmed');
  assert.equal(Date.parse(first.booking.startsAt), Date.parse(firstSlot));
  assert.ok(first.calendarEvent.description.includes(anaName));
  await propose(sofia, `Hello! My name is ${sofiaName}, my Instagram handle is @testsofia${suffix}. Book my free trial at exactly ${firstSlot} (UTC; convert to Dallas time). Use only my Instagram contact; I do not want WhatsApp messages.`);
  const shared = await confirm(sofia, 'confirmed');
  assert.equal(shared.booking.calendar.eventId, first.booking.calendar.eventId);
  assert.ok(shared.calendarEvent.description.includes(anaName));
  assert.ok(shared.calendarEvent.description.includes(sofiaName));
  await propose(ana, `Please reschedule my booking ${first.booking.id} to exactly ${secondSlot} (UTC).`);
  const moved = await confirm(ana, 'confirmed');
  assert.equal(moved.booking.id, first.booking.id);
  assert.equal(Date.parse(moved.booking.startsAt), Date.parse(secondSlot));
  assert.ok(moved.calendarEvent.description.includes(anaName));
  assert.ok(!moved.calendarEvent.description.includes(sofiaName));
  const original = await send(sofia, 'Please check my current booking.');
  assert.ok(original.calendarEvent.description.includes(sofiaName));
  assert.ok(!original.calendarEvent.description.includes(anaName));
  await propose(sofia, `Please cancel my booking ${shared.booking.id}.`);
  const cancelled = await confirm(sofia, 'cancelled');
  assert.equal(cancelled.booking.status, 'cancelled');
  assert.ok(!cancelled.calendarEvent.description.includes(sofiaName));
  await propose(ana, `Please cancel my booking ${first.booking.id}.`);
  const cleanup = await confirm(ana, 'cancelled');
  assert.ok(!cleanup.calendarEvent.description.includes(anaName));
  console.log('\nPASS: real model, remote D1, shared Calendar roster, retry replay, reschedule and cancellation. Synthetic bookings cancelled; empty Calendar events remain by design.');
} else if (process.argv[2] === '--send') {
  if (!process.argv[3] || !process.argv[4]) throw new Error('Usage: npm run chat -- --send <conversation-id> "message" [message-id]');
  const turn = await send(process.argv[3], process.argv[4], process.argv[5]);
  console.log(JSON.stringify(turn, null, 2));
} else {
  const conversationId = process.argv[2] ?? `chat-${randomUUID()}`;
  console.log(`Direct chat: ${baseUrl}\nConversation: ${conversationId}\nReal bookings go to the configured Calendar. Use a synthetic name and Instagram handle. /quit exits; reuse this conversation ID to continue.\nSuggested UTC slots: ${futureSlots().join(', ')}`);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const text = await terminal.question('\nYou: ');
      if (text.trim() === '/quit') break;
      if (!text.trim()) continue;
      try {
        const turn = await send(conversationId, text);
        if (turn.booking) console.log(`Booking: ${turn.booking.id} (${turn.booking.status}), ${turn.booking.startsAt}, Calendar event: ${turn.booking.calendar?.eventId ?? 'pending'}`);
      } catch (error) { console.error(error.message); }
    }
  } finally { terminal.close(); }
}
