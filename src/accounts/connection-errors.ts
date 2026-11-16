export type ConnectionStage = 'callback' | 'state' | 'short_token' | 'long_token' | 'account_identity' | 'messaging_subscription' | 'save_account';
export type ConnectionFailureKind = 'invalid_callback' | 'state_expired_or_used' | 'provider_rejected' | 'invalid_response' | 'account_already_assigned' | 'network_or_internal';
type ProviderCategory = 'client_credentials' | 'redirect_uri' | 'authorization_code' | 'permissions' | 'unknown';

/** Never retain provider bodies, URLs, codes supplied by the user, tokens or exception messages. */
export class ConnectionFailure extends Error {
  validatedState = false;
  distribuidoraId?: string;
  providerAccountId?: string;
  checkpointId?: string;
  constructor(readonly stage: ConnectionStage, readonly kind: ConnectionFailureKind,
    readonly details: { httpStatus?: number; providerCode?: number; providerSubcode?: number; category?: ProviderCategory; providerSummary?: string; shortTokenExpiresIn?: number } = {}) {
    super(`Instagram connection failed at ${stage}: ${kind}`);
  }
  publicMessage() {
    if (this.kind === 'account_already_assigned') return 'This Instagram account is already connected to another DWC profile. Its existing assignment was not changed. Use a different professional account or ask the owner to arrange an explicit reassignment.';
    if (this.kind === 'state_expired_or_used') return 'This Instagram authorization link expired or was already used. Ask the owner for a fresh invitation; refreshing this callback cannot retry an authorization code.';
    if (this.details.category === 'client_credentials') return 'Instagram rejected the application credentials. The gym owner must check the Instagram Login App ID and matching App Secret.';
    if (this.details.category === 'redirect_uri') return 'Instagram rejected the redirect URI. The gym owner must register the exact Instagram OAuth callback URL in Meta.';
    if (this.details.category === 'authorization_code') return 'Instagram rejected the one-use authorization code. Start again from a fresh invitation rather than refreshing this callback.';
    if (this.stage === 'messaging_subscription' || this.details.category === 'permissions') return 'Instagram messaging access could not be authorized. Check that this is an eligible professional account and that the app has the required messaging permissions/access.';
    if (this.kind === 'invalid_response') return `Instagram returned an unexpected response during ${this.stage.replace(/_/g, ' ')}. The gym owner can inspect the diagnostic reference.`;
    return `Instagram connection could not complete during ${this.stage.replace(/_/g, ' ')}. The gym owner can inspect the diagnostic reference.`;
  }
}

export class AccountAssignmentError extends Error {
  constructor() { super('Account already belongs to another distribuidora; explicit reassignment is required'); }
}

function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
export function providerFailure(stage: ConnectionStage, status: number, body: unknown, sensitiveValues: readonly string[] = []) {
  const data = body && typeof body === 'object' ? body as Record<string, any> : {};
  const error = data.error && typeof data.error === 'object' ? data.error : data;
  const message = [error.message, data.error_description, data.error_message, typeof data.error === 'string' ? data.error : ''].filter((part) => typeof part === 'string').join(' ');
  const text = message.toLowerCase();
  const category: ProviderCategory = /redirect.?uri|redirect url/.test(text) ? 'redirect_uri'
    : /client.?secret|invalid client|app.?secret|client credentials|invalid platform app|invalid app/.test(text) ? 'client_credentials'
      : /authorization code|code (?:has been|was) used|invalid code|code.*expired/.test(text) ? 'authorization_code'
        : /permission|not authorized|insufficient|professional account/.test(text) ? 'permissions' : 'unknown';
  let summary = message;
  for (const value of sensitiveValues.filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const variant of new Set([value, encodeURIComponent(value)])) summary = summary.split(variant).join('[redacted]');
  }
  summary = summary.replace(/https?:\/\/[^\s<>"']+/gi, '[redacted-url]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/[A-Za-z0-9_+/=%.\-]{24,}/g, '[redacted-value]').replace(/\s+/g, ' ').slice(0, 350);
  return new ConnectionFailure(stage, 'provider_rejected', { httpStatus: status, providerCode: number(error.code), providerSubcode: number(error.error_subcode), category,
    ...(summary ? { providerSummary: summary } : {}) });
}
