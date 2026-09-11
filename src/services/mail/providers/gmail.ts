import { formatEmailAddress, normalizeReceivedAt, parseEmailAddress, splitEmailAddresses } from '../address.ts';
import { authenticatedJson, boundedLimit, isRecord, optionalString, requiredString } from '../http.ts';
import {
  MailProviderError,
  type MailProvider,
  type RemoteMailProviderOptions,
} from '../provider.ts';
import {
  MAIL_PROVIDER,
  type MailConnectionResult,
  type MailHeader,
  type MailPage,
  type MailQueryOptions,
  type NormalizedEmail,
} from '../types.ts';

const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'] as const;
const HEADER_NAMES = ['From', 'To', 'Subject', 'Date'] as const;

type GmailCursorState =
  | {
      version: 1;
      mode: 'initial-page';
      pageToken: string;
      checkpointHistoryId: string;
      query?: string;
    }
  | {
      version: 1;
      mode: 'history';
      startHistoryId: string;
      pageToken?: string;
      checkpointHistoryId?: string;
    };

interface GmailMessagePart {
  mimeType?: string;
  headers: Map<string, string>;
  bodyData?: string;
  attachmentId?: string;
  parts: GmailMessagePart[];
}

interface GmailMessage {
  id: string;
  threadId?: string;
  historyId?: string;
  internalDate?: string;
  payload: GmailMessagePart;
}

export class GmailProvider implements MailProvider {
  readonly kind = MAIL_PROVIDER.GMAIL;
  readonly accountId: string;

  private readonly tokenProvider: RemoteMailProviderOptions['tokenProvider'];
  private readonly fetcher: NonNullable<RemoteMailProviderOptions['fetch']>;
  private readonly timeoutMs: number | undefined;
  private readonly baseUrl: string;

  constructor(options: RemoteMailProviderOptions) {
    this.accountId = nonEmptyOption(options.accountId, 'accountId');
    this.tokenProvider = options.tokenProvider;
    this.fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? 'https://gmail.googleapis.com/gmail/v1');
  }

  async testConnection(signal?: AbortSignal): Promise<MailConnectionResult> {
    try {
      const profile = await this.getProfile(signal);
      return {
        connected: true,
        accountId: this.accountId,
        emailAddress: profile.emailAddress,
      };
    } catch (error) {
      if (error instanceof MailProviderError) {
        return {
          connected: false,
          accountId: this.accountId,
          errorCode: error.code,
          message: error.message,
        };
      }
      throw error;
    }
  }

  async listHeaders(options: MailQueryOptions): Promise<MailPage<MailHeader>> {
    let limit: number;
    let initialQuery: string | undefined;
    try {
      limit = boundedLimit(options.limit, 500);
      initialQuery = !options.cursor && options.since
        ? `after:${unixSeconds(options.since)}`
        : undefined;
    } catch (error) {
      throw new MailProviderError({
        code: 'INVALID_REQUEST',
        provider: this.kind,
        message: 'Gmail 查询参数无效',
        cause: error,
      });
    }
    const cursor = options.cursor ? decodeGmailCursor(options.cursor) : undefined;
    if (cursor?.mode === 'history') {
      return this.listHistoryHeaders(cursor, limit, options.signal);
    }

    const checkpointHistoryId = cursor?.checkpointHistoryId
      ?? (await this.getProfile(options.signal)).historyId;
    const url = new URL(`${this.baseUrl}/users/me/messages`);
    url.searchParams.set('maxResults', String(limit));
    url.searchParams.append('labelIds', 'INBOX');
    url.searchParams.set('includeSpamTrash', 'false');
    if (cursor?.pageToken) url.searchParams.set('pageToken', cursor.pageToken);
    const query = cursor?.query ?? initialQuery;
    if (query) url.searchParams.set('q', query);

    const page = await this.request(url, options.signal, parseMessageList);
    const items = await this.getHeaders(page.messageIds, options.signal);
    return {
      items,
      ...(page.nextPageToken
        ? {
            nextCursor: encodeGmailCursor({
              version: 1,
              mode: 'initial-page',
              pageToken: page.nextPageToken,
              checkpointHistoryId,
              query,
            }),
          }
        : {
            syncCursor: encodeGmailCursor({
              version: 1,
              mode: 'history',
              startHistoryId: checkpointHistoryId,
            }),
          }),
    };
  }

  async getMessage(messageId: string, signal?: AbortSignal): Promise<NormalizedEmail> {
    let id: string;
    try {
      id = nonEmptyOption(messageId, 'messageId');
    } catch (error) {
      throw new MailProviderError({
        code: 'INVALID_REQUEST',
        provider: this.kind,
        message: 'Gmail messageId 无效',
        cause: error,
      });
    }
    const url = new URL(`${this.baseUrl}/users/me/messages/${encodeURIComponent(id)}`);
    url.searchParams.set('format', 'full');
    const message = await this.request(url, signal, parseGmailMessage);
    const content = await this.readBodyParts(message.id, message.payload, signal);
    const from = parseEmailAddress(headerValue(message.payload, 'from'));
    if (!from.address) throw this.invalidResponse('Gmail message From header is missing');
    return {
      id: message.id,
      threadId: message.threadId,
      accountId: this.accountId,
      provider: this.kind,
      from,
      to: splitEmailAddresses(headerValue(message.payload, 'to')),
      subject: headerValue(message.payload, 'subject'),
      receivedAt: messageReceivedAt(message),
      ...(content.text ? { text: content.text } : {}),
      ...(content.html ? { html: content.html } : {}),
    };
  }

  private async listHistoryHeaders(
    cursor: Extract<GmailCursorState, { mode: 'history' }>,
    limit: number,
    signal?: AbortSignal,
  ): Promise<MailPage<MailHeader>> {
    const url = new URL(`${this.baseUrl}/users/me/history`);
    url.searchParams.set('startHistoryId', cursor.startHistoryId);
    url.searchParams.set('maxResults', String(limit));
    url.searchParams.append('historyTypes', 'messageAdded');
    url.searchParams.set('labelId', 'INBOX');
    if (cursor.pageToken) url.searchParams.set('pageToken', cursor.pageToken);

    const page = await this.request(url, signal, parseHistoryList, true);
    const items = await this.getHeaders(page.messageIds, signal);
    const checkpointHistoryId = page.historyId;
    return {
      items,
      ...(page.nextPageToken
        ? {
            nextCursor: encodeGmailCursor({
              version: 1,
              mode: 'history',
              startHistoryId: cursor.startHistoryId,
              pageToken: page.nextPageToken,
              checkpointHistoryId,
            }),
          }
        : {
            syncCursor: encodeGmailCursor({
              version: 1,
              mode: 'history',
              startHistoryId: checkpointHistoryId,
            }),
          }),
    };
  }

  private async getProfile(signal?: AbortSignal): Promise<{ emailAddress: string; historyId: string }> {
    return this.request(
      new URL(`${this.baseUrl}/users/me/profile`),
      signal,
      (value) => {
        if (!isRecord(value)) throw new TypeError('profile must be an object');
        return {
          emailAddress: requiredString(value.emailAddress, 'emailAddress').toLowerCase(),
          historyId: requiredString(value.historyId, 'historyId'),
        };
      },
    );
  }

  private async getHeader(messageId: string, signal?: AbortSignal): Promise<MailHeader> {
    const url = new URL(`${this.baseUrl}/users/me/messages/${encodeURIComponent(messageId)}`);
    url.searchParams.set('format', 'metadata');
    for (const header of HEADER_NAMES) url.searchParams.append('metadataHeaders', header);
    const message = await this.request(url, signal, parseGmailMessage);
    const from = parseEmailAddress(headerValue(message.payload, 'from'));
    if (!from.address) throw this.invalidResponse('Gmail message From header is missing');
    return {
      id: message.id,
      threadId: message.threadId,
      from: formatEmailAddress(from),
      to: splitEmailAddresses(headerValue(message.payload, 'to')),
      subject: headerValue(message.payload, 'subject'),
      receivedAt: messageReceivedAt(message),
    };
  }

  private async getHeaders(messageIds: readonly string[], signal?: AbortSignal): Promise<MailHeader[]> {
    const headers = await mapWithConcurrency(messageIds, 8, async (messageId) => {
      try {
        return await this.getHeader(messageId, signal);
      } catch (error) {
        // A message may be removed after list/history but before metadata fetch.
        if (error instanceof MailProviderError && error.code === 'NOT_FOUND') return undefined;
        throw error;
      }
    });
    return headers.filter((header): header is MailHeader => header !== undefined);
  }

  private async readBodyParts(
    messageId: string,
    part: GmailMessagePart,
    signal?: AbortSignal,
  ): Promise<{ text: string; html: string }> {
    const text: string[] = [];
    const html: string[] = [];
    const visit = async (current: GmailMessagePart): Promise<void> => {
      const mimeType = current.mimeType?.toLowerCase().split(';')[0]?.trim();
      if (mimeType === 'text/plain' || mimeType === 'text/html') {
        let encoded = current.bodyData;
        if (!encoded && current.attachmentId) {
          const url = new URL(
            `${this.baseUrl}/users/me/messages/${encodeURIComponent(messageId)}`
            + `/attachments/${encodeURIComponent(current.attachmentId)}`,
          );
          encoded = await this.request(url, signal, parseAttachment);
        }
        if (encoded) {
          const decoded = decodeBase64Url(encoded);
          if (mimeType === 'text/plain') text.push(decoded);
          else html.push(decoded);
        }
      }
      for (const child of current.parts) await visit(child);
    };
    await visit(part);
    return { text: joinParts(text), html: joinParts(html) };
  }

  private request<T>(
    url: URL,
    signal: AbortSignal | undefined,
    parse: (value: unknown) => T,
    cursorRequest = false,
  ): Promise<T> {
    return authenticatedJson({
      provider: this.kind,
      accountId: this.accountId,
      scopes: GMAIL_SCOPES,
      tokenProvider: this.tokenProvider,
      fetch: this.fetcher,
      url: url.toString(),
      timeoutMs: this.timeoutMs,
      signal,
      cursorRequest,
      parse,
    });
  }

  private invalidResponse(message: string): MailProviderError {
    return new MailProviderError({ code: 'INVALID_RESPONSE', provider: this.kind, message });
  }
}

function parseMessageList(value: unknown): { messageIds: string[]; nextPageToken?: string } {
  if (!isRecord(value)) throw new TypeError('message list must be an object');
  const messages = value.messages === undefined ? [] : value.messages;
  if (!Array.isArray(messages)) throw new TypeError('messages must be an array');
  return {
    messageIds: messages.map((message, index) => {
      if (!isRecord(message)) throw new TypeError(`messages[${index}] must be an object`);
      return requiredString(message.id, `messages[${index}].id`);
    }),
    nextPageToken: optionalString(value.nextPageToken),
  };
}

function parseHistoryList(value: unknown): {
  messageIds: string[];
  historyId: string;
  nextPageToken?: string;
} {
  if (!isRecord(value)) throw new TypeError('history list must be an object');
  const history = value.history === undefined ? [] : value.history;
  if (!Array.isArray(history)) throw new TypeError('history must be an array');
  const ids = new Set<string>();
  history.forEach((entry, historyIndex) => {
    if (!isRecord(entry)) throw new TypeError(`history[${historyIndex}] must be an object`);
    const added = entry.messagesAdded === undefined ? [] : entry.messagesAdded;
    if (!Array.isArray(added)) throw new TypeError(`history[${historyIndex}].messagesAdded must be an array`);
    added.forEach((addition, additionIndex) => {
      if (!isRecord(addition) || !isRecord(addition.message)) {
        throw new TypeError(`messagesAdded[${additionIndex}] must contain a message`);
      }
      ids.add(requiredString(addition.message.id, 'messagesAdded.message.id'));
    });
  });
  return {
    messageIds: [...ids],
    historyId: requiredString(value.historyId, 'historyId'),
    nextPageToken: optionalString(value.nextPageToken),
  };
}

function parseGmailMessage(value: unknown): GmailMessage {
  if (!isRecord(value)) throw new TypeError('message must be an object');
  if (!isRecord(value.payload)) throw new TypeError('message.payload must be an object');
  return {
    id: requiredString(value.id, 'message.id'),
    threadId: optionalString(value.threadId),
    historyId: optionalString(value.historyId),
    internalDate: optionalString(value.internalDate),
    payload: parseMessagePart(value.payload),
  };
}

function parseMessagePart(value: Record<string, unknown>): GmailMessagePart {
  const headers = new Map<string, string>();
  if (value.headers !== undefined) {
    if (!Array.isArray(value.headers)) throw new TypeError('part.headers must be an array');
    value.headers.forEach((header, index) => {
      if (!isRecord(header)) throw new TypeError(`part.headers[${index}] must be an object`);
      const name = requiredString(header.name, `part.headers[${index}].name`).toLowerCase();
      const headerValue = typeof header.value === 'string' ? header.value : '';
      headers.set(name, headerValue);
    });
  }
  let bodyData: string | undefined;
  let attachmentId: string | undefined;
  if (value.body !== undefined) {
    if (!isRecord(value.body)) throw new TypeError('part.body must be an object');
    bodyData = optionalString(value.body.data);
    attachmentId = optionalString(value.body.attachmentId);
  }
  const rawParts = value.parts === undefined ? [] : value.parts;
  if (!Array.isArray(rawParts)) throw new TypeError('part.parts must be an array');
  return {
    mimeType: optionalString(value.mimeType),
    headers,
    bodyData,
    attachmentId,
    parts: rawParts.map((part, index) => {
      if (!isRecord(part)) throw new TypeError(`part.parts[${index}] must be an object`);
      return parseMessagePart(part);
    }),
  };
}

function parseAttachment(value: unknown): string {
  if (!isRecord(value)) throw new TypeError('attachment must be an object');
  return requiredString(value.data, 'attachment.data');
}

function headerValue(part: GmailMessagePart, name: string): string {
  return part.headers.get(name.toLowerCase()) ?? '';
}

function messageReceivedAt(message: GmailMessage): string {
  return normalizeReceivedAt(message.internalDate ?? headerValue(message.payload, 'date'));
}

function encodeGmailCursor(value: GmailCursorState): string {
  return `gmail:${encodeURIComponent(JSON.stringify(value))}`;
}

function decodeGmailCursor(cursor: string): GmailCursorState {
  try {
    if (!cursor.startsWith('gmail:')) throw new Error('wrong provider');
    const value = JSON.parse(decodeURIComponent(cursor.slice('gmail:'.length))) as unknown;
    if (!isRecord(value) || value.version !== 1) throw new Error('unsupported cursor version');
    if (value.mode === 'initial-page') {
      return {
        version: 1,
        mode: 'initial-page',
        pageToken: requiredString(value.pageToken, 'pageToken'),
        checkpointHistoryId: requiredString(value.checkpointHistoryId, 'checkpointHistoryId'),
        query: optionalString(value.query),
      };
    }
    if (value.mode === 'history') {
      return {
        version: 1,
        mode: 'history',
        startHistoryId: requiredString(value.startHistoryId, 'startHistoryId'),
        pageToken: optionalString(value.pageToken),
        checkpointHistoryId: optionalString(value.checkpointHistoryId),
      };
    }
    throw new Error('unsupported cursor mode');
  } catch (error) {
    throw new MailProviderError({
      code: 'INVALID_REQUEST',
      provider: MAIL_PROVIDER.GMAIL,
      message: 'Gmail cursor 无效',
      cause: error,
    });
  }
}

function unixSeconds(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError('since must be a valid date');
  return Math.floor(timestamp / 1000);
}

function decodeBase64Url(value: string): string {
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch (error) {
    throw new TypeError(`invalid Gmail base64url body: ${error instanceof Error ? error.message : 'decode failed'}`);
  }
}

function joinParts(parts: readonly string[]): string {
  return parts.map(part => part.trim()).filter(Boolean).join('\n\n');
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      result[index] = await mapper(values[index] as T);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    () => worker(),
  ));
  return result;
}

function nonEmptyOption(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must not be empty`);
  return normalized;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new TypeError('Gmail baseUrl must use HTTPS');
  }
  return url.toString().replace(/\/+$/, '');
}
