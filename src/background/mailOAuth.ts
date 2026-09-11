import type {
  MailAccount,
  OAuthAccessToken,
  OAuthTokenProvider,
  OAuthTokenRequest,
} from '../services/mail/accounts.ts';
import { MailProviderError, type FetchLike } from '../services/mail/provider.ts';

export const MAIL_OAUTH_SESSIONS_STORAGE_KEY = 'mailOAuthSessions';

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const OUTLOOK_SCOPES = ['offline_access', 'User.Read', 'Mail.Read'] as const;

interface MailOAuthSession {
  accountId: string;
  provider: 'gmail' | 'outlook';
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  scopes: string[];
  updatedAt: string;
}

interface OAuthEndpoints {
  authorize: string;
  token: string;
  scopes: readonly string[];
}

export interface MailOAuthDependencies {
  getRedirectUrl(path: string): string;
  launchWebAuthFlow(details: { url: string; interactive: boolean }): Promise<string | undefined>;
  fetch: FetchLike;
  readSessions(): Promise<MailOAuthSession[]>;
  writeSessions(sessions: MailOAuthSession[]): Promise<void>;
  randomBytes(length: number): Uint8Array;
  now(): Date;
}

const defaultDependencies: MailOAuthDependencies = {
  getRedirectUrl: path => chrome.identity.getRedirectURL(path),
  launchWebAuthFlow: details => chrome.identity.launchWebAuthFlow(details),
  fetch: (input, init) => globalThis.fetch(input, init),
  readSessions: async () => {
    const result = await chrome.storage.local.get(MAIL_OAUTH_SESSIONS_STORAGE_KEY);
    return normalizeSessions(result[MAIL_OAUTH_SESSIONS_STORAGE_KEY]);
  },
  writeSessions: sessions => chrome.storage.local.set({ [MAIL_OAUTH_SESSIONS_STORAGE_KEY]: sessions }),
  randomBytes: (length) => {
    const value = new Uint8Array(length);
    crypto.getRandomValues(value);
    return value;
  },
  now: () => new Date(),
};

export async function connectMailOAuth(
  account: MailAccount,
  dependencies: MailOAuthDependencies = defaultDependencies,
): Promise<void> {
  if (account.provider !== 'gmail' && account.provider !== 'outlook') {
    throw new Error('只有 Gmail 和 Outlook 使用 OAuth');
  }
  const clientId = account.oauthClientId?.trim();
  if (!clientId) throw new Error('请先填写 OAuth Client ID');

  const endpoints = oauthEndpoints(account.provider);
  const verifier = randomBase64Url(dependencies.randomBytes(48));
  const challenge = await sha256Base64Url(verifier);
  const state = randomBase64Url(dependencies.randomBytes(24));
  const redirectUri = dependencies.getRedirectUrl('mail-oauth');
  const authorizeUrl = new URL(endpoints.authorize);
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', endpoints.scopes.join(' '));
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  if (account.provider === 'gmail') {
    authorizeUrl.searchParams.set('access_type', 'offline');
    authorizeUrl.searchParams.set('prompt', 'consent');
  } else {
    authorizeUrl.searchParams.set('response_mode', 'query');
  }

  const redirect = await dependencies.launchWebAuthFlow({
    url: authorizeUrl.toString(),
    interactive: true,
  });
  if (!redirect) throw new Error('OAuth 授权未完成');
  const resultUrl = new URL(redirect);
  if (resultUrl.searchParams.get('state') !== state) throw new Error('OAuth state 校验失败');
  const oauthError = resultUrl.searchParams.get('error');
  if (oauthError) throw new Error(`OAuth 授权失败：${oauthError}`);
  const code = resultUrl.searchParams.get('code');
  if (!code) throw new Error('OAuth 回调缺少 authorization code');

  const token = await exchangeToken(dependencies.fetch, endpoints.token, {
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const now = dependencies.now();
  const session: MailOAuthSession = {
    accountId: account.id,
    provider: account.provider,
    clientId,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: new Date(now.getTime() + token.expiresIn * 1000).toISOString(),
    scopes: token.scopes.length > 0 ? token.scopes : [...endpoints.scopes],
    updatedAt: now.toISOString(),
  };
  const sessions = await dependencies.readSessions();
  await dependencies.writeSessions([
    ...sessions.filter(existing => existing.accountId !== account.id),
    session,
  ]);
}

export async function disconnectMailOAuth(
  accountId: string,
  dependencies: Pick<MailOAuthDependencies, 'readSessions' | 'writeSessions'> = defaultDependencies,
): Promise<void> {
  const sessions = await dependencies.readSessions();
  await dependencies.writeSessions(sessions.filter(session => session.accountId !== accountId));
}

export class ChromeMailOAuthTokenProvider implements OAuthTokenProvider {
  constructor(private readonly dependencies: MailOAuthDependencies = defaultDependencies) {}

  async getAccessToken(request: OAuthTokenRequest): Promise<OAuthAccessToken> {
    const sessions = await this.dependencies.readSessions();
    const session = sessions.find(value => value.accountId === request.accountId && value.provider === request.provider);
    if (!session) throw authRequired(request.provider, '邮箱账号尚未授权');

    const expiresAt = Date.parse(session.expiresAt);
    if (!request.forceRefresh && expiresAt - this.dependencies.now().getTime() > 60_000) {
      return { accessToken: session.accessToken, expiresAt: session.expiresAt };
    }
    if (!session.refreshToken) throw authRequired(request.provider, 'OAuth 登录已过期，请重新授权');

    const token = await exchangeToken(
      this.dependencies.fetch,
      oauthEndpoints(session.provider).token,
      {
        client_id: session.clientId,
        refresh_token: session.refreshToken,
        grant_type: 'refresh_token',
      },
    );
    const now = this.dependencies.now();
    const updated: MailOAuthSession = {
      ...session,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? session.refreshToken,
      expiresAt: new Date(now.getTime() + token.expiresIn * 1000).toISOString(),
      scopes: token.scopes.length > 0 ? token.scopes : session.scopes,
      updatedAt: now.toISOString(),
    };
    await this.dependencies.writeSessions(sessions.map(value => value.accountId === updated.accountId ? updated : value));
    return { accessToken: updated.accessToken, expiresAt: updated.expiresAt };
  }

  async invalidateAccessToken(request: OAuthTokenRequest, accessToken: string): Promise<void> {
    const sessions = await this.dependencies.readSessions();
    const session = sessions.find(value => value.accountId === request.accountId && value.provider === request.provider);
    if (!session || session.accessToken !== accessToken) return;
    await this.dependencies.writeSessions(sessions.map(value => value.accountId === session.accountId
      ? { ...value, expiresAt: new Date(0).toISOString() }
      : value));
  }
}

function oauthEndpoints(provider: 'gmail' | 'outlook'): OAuthEndpoints {
  return provider === 'gmail'
    ? {
        authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
        token: 'https://oauth2.googleapis.com/token',
        scopes: [GMAIL_SCOPE],
      }
    : {
        authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
        token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        scopes: OUTLOOK_SCOPES,
      };
}

async function exchangeToken(
  fetcher: FetchLike,
  endpoint: string,
  fields: Record<string, string>,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number; scopes: string[] }> {
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  const raw = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`OAuth token endpoint 返回非 JSON（HTTP ${response.status}）`);
  }
  if (!response.ok || !isRecord(value)) {
    throw new Error(`OAuth token 交换失败（HTTP ${response.status}）`);
  }
  const accessToken = typeof value.access_token === 'string' ? value.access_token.trim() : '';
  const expiresIn = typeof value.expires_in === 'number' && Number.isFinite(value.expires_in)
    ? Math.max(60, value.expires_in)
    : 3600;
  if (!accessToken) throw new Error('OAuth token 响应缺少 access_token');
  return {
    accessToken,
    refreshToken: typeof value.refresh_token === 'string' && value.refresh_token.trim()
      ? value.refresh_token.trim()
      : undefined,
    expiresIn,
    scopes: typeof value.scope === 'string' ? value.scope.split(/\s+/).filter(Boolean) : [],
  };
}

function normalizeSessions(input: unknown): MailOAuthSession[] {
  if (!Array.isArray(input)) return [];
  return input.filter((value): value is MailOAuthSession => (
    isRecord(value)
    && typeof value.accountId === 'string'
    && (value.provider === 'gmail' || value.provider === 'outlook')
    && typeof value.clientId === 'string'
    && typeof value.accessToken === 'string'
    && typeof value.expiresAt === 'string'
    && Array.isArray(value.scopes)
  ));
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return randomBase64Url(new Uint8Array(digest));
}

function randomBase64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function authRequired(provider: 'gmail' | 'outlook', message: string): MailProviderError {
  return new MailProviderError({ code: 'AUTH_REQUIRED', provider, message, retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
