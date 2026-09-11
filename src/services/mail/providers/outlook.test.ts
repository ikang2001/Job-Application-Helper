import assert from 'node:assert/strict';
import test from 'node:test';
import type { OAuthTokenProvider } from '../accounts.ts';
import { MailProviderError } from '../provider.ts';
import { OutlookProvider } from './outlook.ts';

function graphMessage(id: string, subject: string) {
  return {
    id,
    conversationId: `conversation-${id}`,
    sender: { emailAddress: { name: 'Contoso Recruiting', address: 'jobs@contoso.com' } },
    toRecipients: [{ emailAddress: { name: 'Candidate', address: 'candidate@example.com' } }],
    subject,
    receivedDateTime: '2026-09-01T08:00:00Z',
  };
}

test('Outlook consumes Graph delta pages and requests ImmutableId on every call', async () => {
  const requests: Array<{ url: URL; prefer: string | null; authorization: string | null }> = [];
  const tokenProvider: OAuthTokenProvider = {
    async getAccessToken(request) {
      assert.equal(request.provider, 'outlook');
      assert.deepEqual(request.scopes, ['Mail.Read']);
      return { accessToken: 'graph-token' };
    },
  };
  const fetchMock: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      prefer: headers.get('Prefer'),
      authorization: headers.get('Authorization'),
    });
    if (url.searchParams.has('$skiptoken')) {
      return json({
        value: [
          { id: 'removed', '@removed': { reason: 'deleted' } },
          graphMessage('m2', 'Offer letter'),
        ],
        '@odata.deltaLink': 'https://graph.test/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=done',
      });
    }
    return json({
      value: [graphMessage('m1', 'Interview invitation')],
      '@odata.nextLink': 'https://graph.test/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=next',
    });
  };
  const provider = new OutlookProvider({
    accountId: 'outlook-account',
    tokenProvider,
    fetch: fetchMock,
    baseUrl: 'https://graph.test/v1.0',
  });

  const first = await provider.listHeaders({
    since: '2026-08-01T00:00:00.000Z',
    limit: 50,
  });
  assert.deepEqual(first.items.map(item => item.id), ['m1']);
  assert.ok(first.nextCursor);
  const initial = requests[0]?.url;
  assert.equal(initial?.pathname, '/v1.0/me/mailFolders/inbox/messages/delta');
  assert.equal(initial?.searchParams.get('$top'), '50');
  assert.equal(initial?.searchParams.get('changeType'), 'created');
  assert.equal(initial?.searchParams.get('$filter'), 'receivedDateTime ge 2026-08-01T00:00:00.000Z');

  const second = await provider.listHeaders({ cursor: first.nextCursor, limit: 50 });
  assert.deepEqual(second.items.map(item => item.id), ['m2']);
  assert.ok(second.syncCursor);
  assert.equal(second.nextCursor, undefined);
  assert.ok(requests.every(request => request.prefer?.includes('IdType="ImmutableId"')));
  assert.ok(requests.every(request => request.authorization === 'Bearer graph-token'));
});

test('Outlook gets a normalized text body with an encoded immutable message ID', async () => {
  let requestedUrl: URL | undefined;
  const provider = new OutlookProvider({
    accountId: 'outlook-account',
    tokenProvider: fixedTokenProvider(),
    baseUrl: 'https://graph.test/v1.0',
    fetch: async (input, init) => {
      requestedUrl = new URL(String(input));
      assert.match(new Headers(init?.headers).get('Prefer') ?? '', /outlook\.body-content-type="text"/);
      return json({
        ...graphMessage('A/B+C=', 'Assessment invitation'),
        body: { contentType: 'text', content: 'Please complete the assessment.' },
      });
    },
  });
  const message = await provider.getMessage('A/B+C=');
  assert.match(requestedUrl?.pathname ?? '', /A%2FB%2BC%3D/);
  assert.equal(message.id, 'A/B+C=');
  assert.deepEqual(message.from, { name: 'Contoso Recruiting', address: 'jobs@contoso.com' });
  assert.deepEqual(message.to, ['candidate@example.com']);
  assert.equal(message.text, 'Please complete the assessment.');
});

test('Outlook rejects a cursor that could exfiltrate the OAuth token', async () => {
  let called = false;
  const provider = new OutlookProvider({
    accountId: 'outlook-account',
    tokenProvider: fixedTokenProvider(),
    baseUrl: 'https://graph.test/v1.0',
    fetch: async () => {
      called = true;
      return json({});
    },
  });
  const malicious = `outlook:${encodeURIComponent('https://attacker.example/collect?$deltatoken=secret')}`;
  await assert.rejects(
    provider.listHeaders({ cursor: malicious, limit: 10 }),
    (error: unknown) => error instanceof MailProviderError && error.code === 'INVALID_REQUEST',
  );
  assert.equal(called, false);
});

test('Outlook invalidates a rejected OAuth token and classifies the error', async () => {
  let invalidated = '';
  const tokenProvider: OAuthTokenProvider = {
    async getAccessToken() {
      return { accessToken: 'expired-token' };
    },
    async invalidateAccessToken(_request, accessToken) {
      invalidated = accessToken;
    },
  };
  const provider = new OutlookProvider({
    accountId: 'outlook-account',
    tokenProvider,
    baseUrl: 'https://graph.test/v1.0',
    fetch: async () => json({ error: { message: 'InvalidAuthenticationToken' } }, 401),
  });
  const result = await provider.testConnection();
  assert.equal(result.connected, false);
  assert.equal(result.errorCode, 'AUTH_REQUIRED');
  assert.equal(invalidated, 'expired-token');
});

function fixedTokenProvider(): OAuthTokenProvider {
  return {
    async getAccessToken() {
      return { accessToken: 'graph-token' };
    },
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
