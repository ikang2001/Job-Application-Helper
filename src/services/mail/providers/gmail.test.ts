import assert from 'node:assert/strict';
import test from 'node:test';
import type { OAuthTokenProvider } from '../accounts.ts';
import { MailProviderError } from '../provider.ts';
import { GmailProvider } from './gmail.ts';

const tokenProvider: OAuthTokenProvider = {
  async getAccessToken(request) {
    assert.equal(request.provider, 'gmail');
    assert.deepEqual(request.scopes, ['https://www.googleapis.com/auth/gmail.readonly']);
    return { accessToken: 'gmail-token' };
  },
};

function metadataMessage(id: string, subject: string, internalDate = '1788249600000') {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate,
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: '"Acme Recruiting" <recruiting@acme.com>' },
        { name: 'To', value: 'Candidate <candidate@example.com>' },
        { name: 'Subject', value: subject },
        { name: 'Date', value: 'Tue, 1 Sep 2026 08:00:00 +0000' },
      ],
    },
  };
}

test('Gmail paginates initial headers then advances through a history cursor', async () => {
  const requests: Array<{ url: URL; authorization: string | null }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({
      url,
      authorization: new Headers(init?.headers).get('Authorization'),
    });
    if (url.pathname.endsWith('/profile')) {
      return json({ emailAddress: 'candidate@example.com', historyId: '100' });
    }
    if (url.pathname.endsWith('/messages')) {
      if (url.searchParams.get('pageToken') === 'page-2') {
        return json({ messages: [{ id: 'm2', threadId: 't2' }] });
      }
      return json({
        messages: [{ id: 'm1', threadId: 't1' }],
        nextPageToken: 'page-2',
      });
    }
    if (url.pathname.endsWith('/history')) {
      assert.equal(url.searchParams.get('startHistoryId'), '100');
      assert.equal(url.searchParams.get('historyTypes'), 'messageAdded');
      return json({
        history: [
          { messagesAdded: [{ message: { id: 'h1' } }, { message: { id: 'h1' } }] },
        ],
        historyId: '125',
      });
    }
    const messageId = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
    if (messageId) return json(metadataMessage(messageId, `Interview invitation ${messageId}`));
    return json({ error: { message: 'unexpected request' } }, 500);
  };
  const provider = new GmailProvider({
    accountId: 'gmail-account',
    tokenProvider,
    fetch: fetchMock,
    baseUrl: 'https://gmail.test/gmail/v1',
  });

  const first = await provider.listHeaders({
    since: '2026-08-01T00:00:00.000Z',
    limit: 20,
  });
  assert.deepEqual(first.items.map(item => item.id), ['m1']);
  assert.ok(first.nextCursor);
  assert.equal(first.syncCursor, undefined);
  const firstListUrl = requests.find(request => request.url.pathname.endsWith('/messages'))?.url;
  assert.equal(firstListUrl?.searchParams.get('q'), 'after:1785542400');

  const second = await provider.listHeaders({ cursor: first.nextCursor, limit: 20 });
  assert.deepEqual(second.items.map(item => item.id), ['m2']);
  assert.ok(second.syncCursor);
  assert.equal(second.nextCursor, undefined);
  const secondListUrl = requests.filter(request => request.url.pathname.endsWith('/messages'))[1]?.url;
  assert.equal(secondListUrl?.searchParams.get('q'), 'after:1785542400');

  const incremental = await provider.listHeaders({ cursor: second.syncCursor, limit: 20 });
  assert.deepEqual(incremental.items.map(item => item.id), ['h1']);
  assert.ok(incremental.syncCursor);
  assert.ok(requests.every(request => request.authorization === 'Bearer gmail-token'));
  assert.ok(requests.some(request =>
    request.url.searchParams.get('format') === 'metadata'
    && request.url.searchParams.getAll('metadataHeaders').join(',') === 'From,To,Subject,Date'));
});

test('Gmail full-message adapter decodes nested base64url text/html bodies', async () => {
  const fetchMock: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('format'), 'full');
    return json({
      ...metadataMessage('full-1', 'Application received'),
      payload: {
        ...metadataMessage('full-1', 'Application received').payload,
        parts: [
          { mimeType: 'text/plain', body: { data: base64url('你好，已收到你的申请。') } },
          { mimeType: 'text/html', body: { data: base64url('<p>你好，已收到你的申请。</p>') } },
        ],
      },
    });
  };
  const provider = new GmailProvider({
    accountId: 'gmail-account',
    tokenProvider,
    fetch: fetchMock,
    baseUrl: 'https://gmail.test/gmail/v1',
  });
  const message = await provider.getMessage('full-1');
  assert.equal(message.provider, 'gmail');
  assert.deepEqual(message.from, { name: 'Acme Recruiting', address: 'recruiting@acme.com' });
  assert.deepEqual(message.to, ['candidate@example.com']);
  assert.equal(message.text, '你好，已收到你的申请。');
  assert.equal(message.html, '<p>你好，已收到你的申请。</p>');
});

test('Gmail stale history IDs are classified as CURSOR_EXPIRED', async () => {
  let expireHistory = false;
  const fetchMock: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/profile')) {
      return json({ emailAddress: 'candidate@example.com', historyId: '100' });
    }
    if (url.pathname.endsWith('/messages')) return json({ messages: [] });
    if (url.pathname.endsWith('/history') && expireHistory) {
      return json({ error: { message: 'Requested entity was not found.' } }, 404);
    }
    return json({ history: [], historyId: '101' });
  };
  const provider = new GmailProvider({
    accountId: 'gmail-account',
    tokenProvider,
    fetch: fetchMock,
    baseUrl: 'https://gmail.test/gmail/v1',
  });
  const initial = await provider.listHeaders({ limit: 10 });
  assert.ok(initial.syncCursor);
  expireHistory = true;
  await assert.rejects(
    provider.listHeaders({ limit: 10, cursor: initial.syncCursor }),
    (error: unknown) => error instanceof MailProviderError
      && error.code === 'CURSOR_EXPIRED'
      && error.retryable === false,
  );
});

test('Gmail connection timeout is normalized and does not leak a rejected fetch', async () => {
  const fetchMock: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  const provider = new GmailProvider({
    accountId: 'gmail-account',
    tokenProvider,
    fetch: fetchMock,
    baseUrl: 'https://gmail.test/gmail/v1',
    timeoutMs: 5,
  });
  const result = await provider.testConnection();
  assert.equal(result.connected, false);
  assert.equal(result.errorCode, 'TIMEOUT');
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function base64url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
