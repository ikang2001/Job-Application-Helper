import type { MailProviderKind } from './types.ts';

export interface MailAccount {
  id: string;
  provider: MailProviderKind;
  emailAddress: string;
  displayName?: string;
  enabled: boolean;
  cursor?: string;
  oauthClientId?: string;
  imap?: {
    provider: 'qq' | '163' | '126' | 'imap';
    host: string;
    port: number;
    secure: true;
    username: string;
  };
  lastSyncAt?: string;
  lastError?: string;
  connectionState?: 'disconnected' | 'connected' | 'needs-authorization' | 'error';
  createdAt?: string;
  updatedAt?: string;
}

export interface OAuthTokenRequest {
  provider: Extract<MailProviderKind, 'gmail' | 'outlook'>;
  accountId: string;
  scopes: readonly string[];
  forceRefresh?: boolean;
}

export interface OAuthAccessToken {
  accessToken: string;
  /** ISO timestamp. Token providers may omit it when the host manages expiry. */
  expiresAt?: string;
}

/**
 * The mail adapters never persist OAuth credentials. A host implementation can
 * use chrome.identity, an OS credential store, or a backend token broker.
 */
export interface OAuthTokenProvider {
  getAccessToken(request: OAuthTokenRequest): Promise<OAuthAccessToken>;
  invalidateAccessToken?(request: OAuthTokenRequest, accessToken: string): Promise<void>;
}

export function normalizeMailAccount(account: MailAccount): MailAccount {
  return {
    ...account,
    id: account.id.trim(),
    emailAddress: account.emailAddress.trim().toLowerCase(),
    displayName: account.displayName?.trim() || undefined,
    cursor: account.cursor?.trim() || undefined,
    oauthClientId: account.oauthClientId?.trim() || undefined,
    imap: account.imap ? {
      ...account.imap,
      host: account.imap.host.trim().toLowerCase(),
      port: Math.max(1, Math.min(65535, Math.trunc(account.imap.port))),
      secure: true,
      username: account.imap.username.trim(),
    } : undefined,
    lastError: account.lastError?.trim() || undefined,
  };
}
