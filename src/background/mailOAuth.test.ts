import assert from 'node:assert/strict';
import test from 'node:test';
import type { MailAccount } from '../services/mail/accounts.ts';
import {
  ChromeMailOAuthTokenProvider,
  connectMailOAuth,
  disconnectMailOAuth,
  type MailOAuthDependencies,
} from './mailOAuth.ts';

type Session = Awaited<ReturnType<MailOAuthDependencies['readSessions']>>[number];

const account: MailAccount = {
  id: 'gmail-1', provider: 'gmail', emailAddress: 'candidate@gmail.com', enabled: true,
  oauthClientId: 'client-id.apps.googleusercontent.com',
};

function createDeps() {
  let sessions: Session[] = [];
  let launchedUrl = '';
  const deps: MailOAuthDependencies = {
    getRedirectUrl: () => 'https://extension-id.chromiumapp.org/mail-oauth',
    launchWebAuthFlow: async ({ url }) => {
      launchedUrl = url;
      const state = new URL(url).searchParams.get('state');
      return `https://extension-id.chromiumapp.org/mail-oauth?code=auth-code&state=${state}`;
    },
    fetch: async (_input, init) => {
      const body = new URLSearchParams(String(init?.body));
      const isRefresh = body.get('grant_type') === 'refresh_token';
      return new Response(JSON.stringify({
        access_token: isRefresh ? 'access-refreshed' : 'access-first',
        refresh_token: isRefresh ? undefined : 'refresh-first',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
      }), { status: 200 });
    },
    readSessions: async () => sessions,
    writeSessions: async value => { sessions = structuredClone(value); },
    randomBytes: length => new Uint8Array(length).fill(7),
    now: () => new Date('2026-09-03T00:00:00.000Z'),
  };
  return { deps, getSessions: () => sessions, getLaunchedUrl: () => launchedUrl };
}

test('Gmail 使用 Authorization Code + PKCE 并保存 refresh token', async () => {
  const harness = createDeps();
  await connectMailOAuth(account, harness.deps);

  const authorize = new URL(harness.getLaunchedUrl());
  assert.equal(authorize.hostname, 'accounts.google.com');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('access_type'), 'offline');
  assert.equal(harness.getSessions()[0]?.refreshToken, 'refresh-first');
});

test('过期 access token 通过 refresh token 刷新且保留旧 refresh token', async () => {
  const harness = createDeps();
  await connectMailOAuth(account, harness.deps);
  const expired = harness.getSessions().map(session => ({ ...session, expiresAt: '2020-01-01T00:00:00.000Z' }));
  await harness.deps.writeSessions(expired);

  const token = await new ChromeMailOAuthTokenProvider(harness.deps).getAccessToken({
    provider: 'gmail', accountId: account.id, scopes: [],
  });
  assert.equal(token.accessToken, 'access-refreshed');
  assert.equal(harness.getSessions()[0]?.refreshToken, 'refresh-first');
});

test('state 不匹配时拒绝保存 OAuth session', async () => {
  const harness = createDeps();
  harness.deps.launchWebAuthFlow = async () => (
    'https://extension-id.chromiumapp.org/mail-oauth?code=auth-code&state=wrong'
  );
  await assert.rejects(connectMailOAuth(account, harness.deps), /state 校验失败/);
  assert.equal(harness.getSessions().length, 0);
});

test('断开账号会清理本地 OAuth session', async () => {
  const harness = createDeps();
  await connectMailOAuth(account, harness.deps);
  await disconnectMailOAuth(account.id, harness.deps);
  assert.equal(harness.getSessions().length, 0);
});
