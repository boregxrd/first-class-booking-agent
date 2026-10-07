import { Hono } from 'hono';
import type { Env } from '../types/env.js';

const contact = 'dallaswellnessclubweb@gmail.com';

function page(title: string, content: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} | Dallas Wellness Club</title>
  <style>
    body { margin: 0; background: #f8fafc; color: #172033; font: 17px/1.65 system-ui, sans-serif; }
    main { max-width: 780px; margin: 32px auto; padding: 24px; background: white; border-radius: 12px; }
    h1, h2 { line-height: 1.25; } h2 { margin-top: 32px; }
    a { color: #1749a6; overflow-wrap: anywhere; } nav { margin-bottom: 24px; }
    .updated { color: #526074; } li { margin-bottom: 8px; }
  </style>
</head>
<body><main>
  <nav aria-label="Privacy information"><a href="/privacy">Privacy policy</a> · <a href="/data-deletion">Data deletion instructions</a></nav>
  <h1>${title}</h1>
  <p class="updated">Dallas Wellness Club · First-Class Booking Agent<br>Last updated: October 7, 2026</p>
  ${content}
  <footer><p>Contact: <a href="mailto:${contact}">${contact}</a></p></footer>
</main></body>
</html>`;
}

const privacy = page('Privacy policy', `
  <p>This policy describes how Dallas Wellness Club's First-Class Booking Agent handles information when you message the connected Instagram account, use the booking assistant, or use WhatsApp booking messaging when that feature is enabled. The assistant helps prospective customers ask questions and book, reschedule, or cancel a free trial class.</p>
  <h2>Information the application handles</h2>
  <ul>
    <li>Messages you send and the assistant's replies, including information you choose to share.</li>
    <li>Your channel-specific account identifiers, message identifiers and timestamps; your name, Instagram handle, preferred language, and phone number if provided.</li>
    <li>Trial booking dates, times, status, booking identifiers and Calendar event references.</li>
    <li>Messaging consent and opt-out records; delivery status, errors, retry information and operational identifiers used to keep bookings and messages reliable.</li>
  </ul>
  <p>The application does not need your Instagram password or payment-card details. Please do not send passwords, payment information or sensitive medical information in the booking chat.</p>
  <h2>How information is used</h2>
  <p>Information is used to respond to gym questions, maintain conversation context, prepare and manage trial bookings, display class rosters to gym staff, send permitted booking messages when enabled, honor opt-outs, and prevent duplicate bookings or messages. Operational information is used to investigate failures and recover interrupted work.</p>
  <h2>AI-assisted conversations</h2>
  <p>Responses are generated with assistance from OpenAI. The application sends recent conversation context and relevant gym or booking information to OpenAI to generate responses and tool requests. Booking actions are validated by the application and require an explicit confirmation. Model API requests set <code>store: false</code>; this does not mean the provider has no processing, security-log or retention obligations under its own policies.</p>
  <h2>Service providers and staff access</h2>
  <ul>
    <li><strong>Meta / Instagram:</strong> delivers Instagram messages and accepts replies. Meta / WhatsApp provides WhatsApp messaging when enabled.</li>
    <li><strong>Cloudflare:</strong> hosts the application, stores conversation and booking data in D1, and runs background queues and operational logging.</li>
    <li><strong>OpenAI:</strong> processes conversation context to generate AI-assisted responses.</li>
    <li><strong>Google Calendar:</strong> displays trial rosters containing names, provided contact details, language and booking identifiers. Gym staff and authorized operators with access to the booking calendar can view these rosters.</li>
  </ul>
  <p>Each provider also handles information under its own applicable terms and privacy policies. Copies held independently by a messaging platform or service provider are not necessarily removed when records are deleted from this application.</p>
  <h2>Retention</h2>
  <p>Scheduled cleanup normally removes stored chat-history text after 30 days and clears processed inbox payloads and completed outgoing-message text on the same schedule. Processed-turn records, which can include copies of replies, and certain deduplication and delivery records are retained for up to 90 days. Pending work may be retained longer to complete or resolve it.</p>
  <p>Customer, booking, consent and some operational records do not currently have an automatic expiry and remain until manually removed. Calendar roster entries also remain until updated or removed. You can request deletion using the instructions linked below. Provider logs, backups and independently retained platform records may follow separate retention schedules.</p>
  <h2>Your choices and requests</h2>
  <p>You may ask to correct your details, cancel a trial booking, or request deletion of information held by this application. Cancelling a booking or deleting an Instagram conversation is not itself a request to delete all application records. When WhatsApp messaging is enabled, sending <strong>STOP</strong> opts out of booking confirmations and reminders; it does not delete your data or cancel your booking.</p>
  <p>For access, correction or privacy questions, email <a href="mailto:${contact}">${contact}</a>. For removal requests, follow our <a href="/data-deletion">data deletion instructions</a>. We may ask for limited additional information to verify that a request concerns your own records.</p>
  <h2>Contact and policy updates</h2>
  <p>Dallas Wellness Club's booking-assistant contact is <a href="mailto:${contact}">${contact}</a>. Changes to this policy will be published on this page with an updated date.</p>
`);

const deletion = page('Data deletion instructions', `
  <p>You can request deletion of information held by Dallas Wellness Club's First-Class Booking Agent by emailing <a href="mailto:${contact}?subject=Booking%20agent%20data%20deletion%20request">${contact}</a>.</p>
  <h2>How to submit a request</h2>
  <ol>
    <li>Use the subject <strong>Booking agent data deletion request</strong>.</li>
    <li>Tell us the Instagram username you used to contact the gym and which gym account you messaged. If you used WhatsApp, include the phone number used, with its country code.</li>
    <li>If available, include your booking name and trial date or booking ID so we can locate the correct records. Tell us if you also want an upcoming trial booking cancelled.</li>
  </ol>
  <p>You may write in English or Spanish. Do not send passwords, access tokens, payment details or identity documents with your initial request.</p>
  <h2>What happens next</h2>
  <p>Requests are handled manually by the gym's authorized operator. We will review the request and may ask you to confirm it from the associated messaging account or provide limited matching information before changing records. You do not need to create a separate app account.</p>
  <p>After verifying your request, we will identify the related conversation, customer, booking and consent records, address pending messages or booking operations, and remove the applicable information from the application's active records and Calendar roster. Where any information must be retained for a legal obligation, we will explain the applicable limitation in our response. We will notify you when the request has been processed or explain any limitation.</p>
  <p>This is an email-based deletion process, not an automatic deletion button or API callback. Provider backups, logs or records held independently by Meta, OpenAI, Cloudflare or Google may follow their own retention and deletion processes. Deleting our application records does not automatically delete your Instagram or WhatsApp message history.</p>
  <h2>Cancellation and opt-out are separate</h2>
  <p>Cancelling a class removes you from its active roster but does not erase all stored records. Sending <strong>STOP</strong> disables applicable WhatsApp notifications but does not delete your records. Email us explicitly to request data deletion.</p>
  <h2 lang="es">Cómo solicitar la eliminación de tus datos</h2>
  <p lang="es">Escribe a <a href="mailto:${contact}">${contact}</a> con el asunto <strong>Solicitud de eliminación de datos del asistente de reservas</strong>. Incluye tu usuario de Instagram y, si usaste WhatsApp, tu número con código de país. Puedes agregar el nombre y la fecha de tu reserva para ayudarnos a encontrarla. Revisaremos tu solicitud y podremos pedirte que confirmes que los datos son tuyos. No envíes contraseñas ni documentos de identidad en el primer correo.</p>
  <p>Read our <a href="/privacy">privacy policy</a> for the application's data uses and retention details.</p>
`);

export function createPrivacyRoutes() {
  const routes = new Hono<{ Bindings: Env }>();
  routes.use('*', async (c, next) => {
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    await next();
  });
  routes.get('/privacy', (c) => c.html(privacy));
  routes.get('/data-deletion', (c) => c.html(deletion));
  return routes;
}
