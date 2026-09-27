/**
 * Google Service Account OAuth2 Authentication for Cloudflare Workers
 * Uses native Web Crypto API (RSASSA-PKCS1-v1_5 with SHA-256)
 */

export interface GoogleServiceAccountCredentials {
  clientEmail: string;
  privateKey: string;
}

// In-memory token cache for warm Worker isolates
let cachedToken: { accessToken: string; expiresAt: number } | null = null;

function base64UrlEncode(str: string | Uint8Array): string {
  let base64: string;
  if (typeof str === 'string') {
    const bytes = new TextEncoder().encode(str);
    base64 = btoa(String.fromCharCode(...bytes));
  } else {
    base64 = btoa(String.fromCharCode(...str));
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Parses a PEM formatted PKCS#8 RSA private key into an ArrayBuffer
 */
function pemToArrayBuffer(pem: string): ArrayBuffer {
  // Normalize escaped newlines if passed in environment strings
  const cleanPem = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/, '')
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');

  const binaryString = atob(cleanPem);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Generates an OAuth2 access token for Google Calendar using Service Account credentials.
 */
export async function getGoogleCalendarAccessToken(
  credentials: GoogleServiceAccountCredentials
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  // Return cached token if valid for at least 60 more seconds
  if (cachedToken && cachedToken.expiresAt > now + 60) {
    return cachedToken.accessToken;
  }

  const { clientEmail, privateKey } = credentials;
  if (!clientEmail || !privateKey) {
    throw new Error('Google Calendar credentials missing: clientEmail or privateKey is undefined.');
  }

  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };

  const payload = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/calendar.events',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, // 1 hour validity
    iat: now,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const privateKeyBuffer = pemToArrayBuffer(privateKey);
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    privateKeyBuffer,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const signature = base64UrlEncode(new Uint8Array(signatureBuffer));
  const jwt = `${signingInput}.${signature}`;

  // Exchange JWT for access token
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    throw new Error(`Google OAuth token exchange failed (${tokenResponse.status}): ${errorText}`);
  }

  const tokenData = (await tokenResponse.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    accessToken: tokenData.access_token,
    expiresAt: now + (tokenData.expires_in || 3600),
  };

  return cachedToken.accessToken;
}
