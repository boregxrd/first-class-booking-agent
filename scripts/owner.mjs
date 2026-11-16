import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const path = new URL('../.owner-credentials.json', import.meta.url);
const base = process.env.OWNER_PORTAL_URL ?? 'https://first-class-booking-agent.dallaswellnessclubweb.workers.dev';
const cwd = new URL('../', import.meta.url);
let local = process.argv[2] === '--google-client' ? null
  : await readFile(path, 'utf8').then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });

function wrangler(args, input) {
  const result = spawnSync('npx', ['wrangler', ...args], { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`Wrangler operation failed. Check Cloudflare login/configuration. ${result.stderr}`);
  return result.stdout;
}

if (process.argv.includes('--setup')) {
  const secrets = JSON.parse(wrangler(['secret', 'list']));
  if (!local) {
    if (secrets.some((secret) => ['ACCOUNT_CREDENTIAL_KEYS', 'ADMIN_API_TOKEN'].includes(secret.name))) {
      throw new Error('Owner secrets already exist remotely. Restore the original private backup; do not replace encryption keys with new random keys.');
    }
    local = { adminToken: randomBytes(32).toString('hex'), keyring: { v1: randomBytes(32).toString('base64') } };
    await writeFile(path, JSON.stringify(local), { mode: 0o600, flag: 'wx' });
  }
  if (typeof local.adminToken !== 'string' || local.adminToken.length < 32 || typeof local.keyring?.v1 !== 'string' || Buffer.from(local.keyring.v1, 'base64').length !== 32) {
    throw new Error('Invalid owner backup. Restore it rather than generating replacement credentials.');
  }
  if (!secrets.some((secret) => secret.name === 'ADMIN_API_TOKEN')) wrangler(['secret', 'put', 'ADMIN_API_TOKEN'], local.adminToken);
  if (!secrets.some((secret) => secret.name === 'ACCOUNT_CREDENTIAL_KEYS')) wrangler(['secret', 'put', 'ACCOUNT_CREDENTIAL_KEYS'], JSON.stringify(local.keyring));
  console.log('Owner secrets installed if missing; existing remote secrets were preserved. Private backup: .owner-credentials.json (ignored, mode 0600). Back it up securely. No credential values are printed.');
} else if (process.argv[2] === '--copy-token') {
  if (typeof local?.adminToken !== 'string' || local.adminToken.length < 32) throw new Error('Restore the private owner backup first.');
  const copied = spawnSync('pbcopy', [], { input: local.adminToken, encoding: 'utf8', timeout: 10_000 });
  if (copied.status !== 0) throw new Error('Could not copy the owner token. This command requires the Mac pbcopy utility.');
  console.log('Owner token copied to the Mac clipboard without displaying it. Paste into Operator token and click Load portal. The encryption key was not copied.');
} else if (process.argv[2] === '--google-client') {
  const filename = process.argv[3];
  if (!filename) throw new Error('Usage: node scripts/owner.mjs --google-client /path/to/downloaded-client.json');
  let input;
  try { input = JSON.parse(await readFile(filename, 'utf8')); }
  catch { throw new Error('Could not read a valid Google OAuth client JSON file. Download the Web application client JSON from Google Console.'); }
  const client = input.web;
  const redirect = new URL('/connections/callback/google', base).toString();
  if (!client || typeof client.client_id !== 'string' || !client.client_id.endsWith('.apps.googleusercontent.com')
    || typeof client.client_secret !== 'string' || !client.client_secret
    || !Array.isArray(client.redirect_uris) || !client.redirect_uris.includes(redirect)) {
    throw new Error(`Expected a Google OAuth Web application client JSON with this exact redirect URI: ${redirect}. A service-account key is not an OAuth Web client.`);
  }
  wrangler(['secret', 'put', 'GOOGLE_OAUTH_CLIENT_ID'], client.client_id);
  wrangler(['secret', 'put', 'GOOGLE_OAUTH_CLIENT_SECRET'], client.client_secret);
  console.log('Google OAuth client installed without printing credential values. Run node scripts/owner.mjs --google to obtain the gym consent link.');
} else {
  if (!local?.adminToken) throw new Error('Run node scripts/owner.mjs --setup first, or restore the private owner backup.');
  const command = process.argv[2] ?? '--status';
  const routes = { '--status': ['/overview'], '--bootstrap': ['/bootstrap', {}], '--google': ['/connections/start', { provider: 'google' }] };
  let requestId;
  if (command === '--create-profile') {
    if (!process.argv[3] || !process.argv[4]) throw new Error('Usage: --create-profile <name> <email> [request-id-to-reuse-on-retry]');
    requestId = process.argv[5] ?? randomUUID();
    console.error(`Profile creation request ID (reuse on retry): ${requestId}`);
    routes[command] = ['/profiles', { name: process.argv[3], email: process.argv[4] }];
  }
  if (['--inspect-calendar', '--provision'].includes(command)) {
    if (!process.argv[3]) throw new Error(`Usage: ${command} <profile-id>`);
    routes[command] = command === '--inspect-calendar' ? [`/profiles/${encodeURIComponent(process.argv[3])}/calendar`]
      : [`/profiles/${encodeURIComponent(process.argv[3])}/provision`, {}];
  }
  if (!routes[command]) throw new Error('Use --setup, --copy-token, --google-client <downloaded-json>, --status, --bootstrap, --google, --create-profile, --inspect-calendar or --provision.');
  const [route, body] = routes[command];
  const response = await fetch(new URL(`/admin/api${route}`, base), { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${local.adminToken}`, 'Content-Type': 'application/json', ...(requestId ? { 'Idempotency-Key': requestId } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`Owner request failed (${response.status}): ${data.error ?? 'check configuration'}`);
  console.log(JSON.stringify(data, null, 2));
}
