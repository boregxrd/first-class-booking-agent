import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from '../types/env.js';

const keysets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
async function constantEqual(a: string, b: string) {
  const hash = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [left, right] = await Promise.all([hash(a), hash(b)]);
  return left.reduce((diff, value, index) => diff | (value ^ right[index]!), 0) === 0;
}

export async function verifyOwnerAccess(token: string, env: Env): Promise<boolean> {
  if (!env.ACCESS_TEAM_DOMAIN || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN) || !env.ACCESS_AUD) return false;
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  let keys = keysets.get(issuer);
  if (!keys) { keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)); keysets.set(issuer, keys); }
  try {
    const { payload } = await jwtVerify(token, keys, { issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'email'] });
    const owners = (env.OWNER_EMAILS ?? '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean);
    return typeof payload.email === 'string' && owners.includes(payload.email.toLowerCase());
  } catch { return false; }
}

/** Access JWTs are cryptographically verified, never trusted as unsigned email headers. */
export async function ownerAuthorized(request: Request, env: Env, verify = verifyOwnerAccess): Promise<boolean> {
  const bearer = request.headers.get('Authorization');
  const apiAccess = Boolean(env.ADMIN_API_TOKEN && env.ADMIN_API_TOKEN.length >= 32 && bearer
    && await constantEqual(bearer, `Bearer ${env.ADMIN_API_TOKEN}`));
  const origin = request.headers.get('Origin');
  if (origin && origin !== env.ADMIN_ORIGIN) return false;
  if (!['GET', 'HEAD'].includes(request.method) && !apiAccess && origin !== env.ADMIN_ORIGIN) return false;
  if (apiAccess) return true;
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
    ?? request.headers.get('Cookie')?.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
  return Boolean(token && token.length <= 16_384 && await verify(token, env));
}
