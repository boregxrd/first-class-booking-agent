export const portalHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DWC · Distribuidoras</title><style>body{font:16px system-ui;max-width:1000px;margin:40px auto;padding:16px;background:#faf8fc;color:#24202a}section,article{background:white;padding:20px;margin:16px 0;border:1px solid #ddd;border-radius:12px}button,input{font:inherit;padding:9px;margin:4px}button{cursor:pointer}small{display:block;color:#555}a{margin:8px}#notice{white-space:pre-wrap}textarea{width:95%;height:90px}</style>
<h1>Dallas Wellness Club</h1><p>Distribuidoras, calendars and connected accounts</p>
<section><label>Operator token (only if Cloudflare Access is unavailable) <input id="token" type="password" autocomplete="off"></label><button id="login">Load portal</button><small>The token stays in this page's memory. Owner Google authorization is only for the gym account.</small></section>
<p id="notice" role="status">Sign in with owner access, or enter your operator token above and click Load portal.</p>
<section><h2>Gym setup</h2><button id="google" disabled>Authorize gym Google: calendars and invitation emails</button><button id="bootstrap">Import existing gym configuration</button><button id="reload">Refresh</button><p id="mode"></p><p id="google-status"></p><p id="email-status"></p><p id="instagram-status"></p><div id="reminders"></div></section>
<section><h2>Add distribuidora</h2><form id="create"><input name="name" placeholder="Name" maxlength="100" required><input name="email" type="email" placeholder="Google-sharing email" required><button>Create calendar and invite</button></form></section>
<div id="profiles"></div><section id="linkbox" hidden><h2>Gym Google authorization</h2><p>Open this one-use link as the gym owner. It expires in 15 minutes.</p><a id="google-open" target="_blank" rel="noopener noreferrer">Open Google authorization</a><textarea id="link" readonly></textarea></section>
<script src="/admin/app.js" defer></script></html>`;

export const portalScript = `
let operatorToken = '', createKey = '', createBody = '';
const emailKeys = new Map();
const el = id => document.getElementById(id);
const notice = text => { el('notice').textContent = text; };

async function api(path, body, method = 'POST', extraHeaders = {}) {
  const response = await fetch('/admin/api' + path, {
    method: body === undefined ? 'GET' : method,
    headers: { ...(operatorToken ? { Authorization: 'Bearer ' + operatorToken } : {}), 'Content-Type': 'application/json', ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json();
  if (response.status === 401) {
    el('google').disabled = true;
    throw Error('Sign in first: enter your operator token above and click Load portal. Google consent is a separate step.');
  }
  if (!response.ok) throw Error(data.error || 'Request failed. Refresh to inspect the recorded status.');
  return data;
}

async function run(action) {
  try { notice('Working…'); await action(); }
  catch (error) { notice(error.message); }
}

function button(text, action) {
  const b = document.createElement('button');
  b.textContent = text;
  b.onclick = () => run(async () => {
    b.disabled = true;
    try { await action(); } finally { b.disabled = false; }
  });
  return b;
}

async function googleConsent() {
  const data = await api('/connections/start', { provider: 'google' });
  const url = new URL(data.authorizationUrl);
  if (url.origin !== 'https://accounts.google.com') throw Error('Unexpected Google authorization destination.');
  el('linkbox').hidden = false;
  el('link').value = url.href;
  el('google-open').href = url.href;
  notice('Open the Google authorization link below as the gym account. Calendar and Gmail send permissions are requested; inbox reading is not requested.');
}

async function emailInvitation(profile) {
  if (!emailKeys.has(profile.id)) emailKeys.set(profile.id, crypto.randomUUID());
  let result;
  try {
    result = await api('/profiles/' + profile.id + '/instagram-invitation', {}, 'POST', { 'Idempotency-Key': emailKeys.get(profile.id) });
  } catch (error) { await load(); throw error; }
  await load();
  if (result.state === 'accepted') {
    emailKeys.delete(profile.id);
    notice('Google accepted the Instagram invitation email to ' + result.recipient + '. Check the recipient mailbox. Its link expires in 24 hours.');
  } else {
    notice('Email delivery is unknown. Check with ' + result.recipient + ' before deliberately sending a new invitation. Retrying the same request does not resend it.');
  }
}

async function connectWhatsApp(profileId) {
  const phoneNumberId = prompt('WhatsApp Cloud API phone-number ID (not a personal phone number):');
  if (!phoneNumberId) return;
  const accessToken = prompt('Existing Business Platform access token (stored encrypted):');
  if (!accessToken) return;
  const expiresAt = prompt('Token expiry ISO timestamp, or leave empty for a non-expiring system-user token:');
  await api('/profiles/' + profileId + '/whatsapp', { phoneNumberId, accessToken, ...(expiresAt ? { expiresAt } : {}) });
  await load();
}

async function load() {
  const data = await api('/overview');
  el('profiles').replaceChildren();
  el('reminders').replaceChildren();
  el('mode').textContent = 'Multi-account routing: ' + (data.multiAccountEnabled ? 'enabled' : 'disabled until rollout');
  el('google').disabled = !data.setup?.googleOAuthConfigured;
  el('google-status').textContent = data.setup?.googleOAuthConfigured
    ? 'Google OAuth client configured. Use the authorization button to grant calendar and invitation-email access.'
    : 'Google OAuth client is not configured. Import the Web client JSON with scripts/owner.mjs --google-client <path>.';
  el('email-status').textContent = data.setup?.invitationEmailAuthorized
    ? 'Gym Google account has Gmail send permission. Gmail API must also be enabled in its Cloud project.'
    : 'Email invitations need Gmail send permission. Enable Gmail API and reauthorize the gym Google account. No inbox-reading permission is needed.';
  el('instagram-status').textContent = data.setup?.instagramOAuthConfigured
    ? 'Instagram OAuth application configured.'
    : 'Instagram invitations are not ready: configure the Instagram OAuth app ID, secret and callback first.';
  for (const profile of data.profiles) {
    const article = document.createElement('article'), title = document.createElement('h2'), info = document.createElement('p');
    title.textContent = profile.name;
    info.textContent = profile.email + ' · ' + (profile.active ? 'Active' : 'Inactive') + ' · Calendar: ' + profile.calendar_setup_status;
    article.append(title, info);
    if (profile.calendar_view_url) {
      const url = new URL(profile.calendar_view_url);
      if (url.origin === 'https://calendar.google.com') {
        const link = document.createElement('a');
        link.href = url.href; link.textContent = 'View calendar'; link.target = '_blank'; link.rel = 'noopener noreferrer'; article.append(link);
      }
    }
    article.append(
      button('Resume calendar setup', async () => { await api('/profiles/' + profile.id + '/provision', {}); await load(); }),
      button(profile.active ? 'Deactivate' : 'Activate', async () => { await api('/profiles/' + profile.id + '/active', { active: !profile.active }); await load(); })
    );
    const emailButton = button('Email Instagram connection invitation', () => emailInvitation(profile));
    emailButton.disabled = !data.setup?.instagramOAuthConfigured || !data.setup?.invitationEmailAuthorized || !profile.active || profile.calendar_setup_status !== 'ready';
    article.append(emailButton, button('Connect existing WhatsApp Cloud API number', () => connectWhatsApp(profile.id)));
    const invitation = (data.invitations || []).find(item => item.distribuidora_id === profile.id);
    if (invitation) {
      const status = document.createElement('p');
      status.textContent = 'Last Instagram email: ' + invitation.state + ' · ' + invitation.recipient + ' · ' + (invitation.opened_at ? 'connection started' : 'not opened') + ' · expires ' + invitation.expires_at;
      article.append(status);
      if (invitation.state === 'unknown') article.append(button('Deliberately send a new invitation', async () => {
        if (!confirm('Delivery is unknown. Have you checked with the recipient and still want a new email?')) return;
        emailKeys.delete(profile.id); await emailInvitation(profile);
      }));
    }
    const note = document.createElement('small');
    note.textContent = 'TikTok: task #10. New WhatsApp Business Platform numbers must be provisioned with Meta first.';
    article.append(note);
    for (const account of data.accounts.filter(item => item.distribuidora_id === profile.id)) {
      const row = document.createElement('p');
      row.textContent = account.platform + ' · ' + (account.handle || account.provider_account_id) + ' · ' + account.status;
      row.append(button('Disconnect locally', async () => { await api('/accounts/' + encodeURIComponent(account.id) + '/disconnect', {}); await load(); }));
      if (account.platform === 'whatsapp' && profile.id === data.generalProfileId) row.append(button(data.reminderSender === account.id ? 'Current gym reminder sender' : 'Use for gym reminders', async () => {
        await api('/reminder-sender', { accountId: account.id }); await load();
      }));
      article.append(row);
    }
    el('profiles').append(article);
  }
  notice('Loaded. Calendar sharing and Instagram connection are separate emails. Trainers do not need owner portal access.');
}

el('login').onclick = () => { operatorToken = el('token').value; el('token').value = ''; run(load); };
el('reload').onclick = () => run(load);
el('google').onclick = () => run(googleConsent);
el('bootstrap').onclick = () => run(async () => { await api('/bootstrap', {}); await load(); });
el('create').onsubmit = event => {
  event.preventDefault();
  const formElement = event.target;
  run(async () => {
    const form = new FormData(formElement), body = { name: form.get('name'), email: form.get('email') };
    if (!createKey || createBody !== JSON.stringify(body)) { createKey = crypto.randomUUID(); createBody = JSON.stringify(body); }
    const data = await api('/profiles', body, 'POST', { 'Idempotency-Key': createKey });
    createKey = ''; createBody = ''; formElement.reset(); await load();
    if (data.setupPending) notice('Profile saved. Authorize gym Google and resume its calendar setup.');
  });
};
run(load);
`;
