import { formatEmailAddress, normalizeReceivedAt } from '../address.ts';
import { authenticatedJson, boundedLimit, isRecord, optionalString, requiredString } from '../http.ts';
import {
  MailProviderError,
  type MailProvider,
  type RemoteMailProviderOptions,
} from '../provider.ts';
import {
  MAIL_PROVIDER,
  type EmailAddress,
  type MailConnectionResult,
  type MailHeader,
  type MailPage,
  type MailQueryOptions,
  type NormalizedEmail,
} from '../types.ts';

const OUTLOOK_SCOPES = ['Mail.Read'] as const;
const IMMUTABLE_ID_PREFER = 'IdType="ImmutableId", outlook.body-content-type="text"';
const MESSAGE_SELECT = [
  'id',
  'conversationId',
  'sender',
  'toRecipients',
  'subject',
  'receivedDateTime',
].join(',');

interface GraphMessage {
  id: string;
  conversationId?: string;
  sender: EmailAddress;
  to: string[];
  subject: string;
  receivedAt: string;
  body?: { contentType: 'text' | 'html'; content: string };
  removed: boolean;
}

interface GraphDeltaPage {
  messages: GraphMessage[];
  nextLink?: string;
  deltaLink?: string;
}

export class OutlookProvider implements MailProvider {
  readonly kind = MAIL_PROVIDER.OUTLOOK;
  readonly accountId: string;

  private readonly tokenProvider: RemoteMailProviderOptions['tokenProvider'];
  private readonly fetcher: NonNullable<RemoteMailProviderOptions['fetch']>;
  private readonly timeoutMs: number | undefined;
  private readonly baseUrl: URL;

  constructor(options: RemoteMailProviderOptions) {
    this.accountId = nonEmptyOption(options.accountId, 'accountId');
    this.tokenProvider = options.tokenProvider;
    this.fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? 'https://graph.microsoft.com/v1.0');
  }

  async testConnection(signal?: AbortSignal): Promise<MailConnectionResult> {
    try {
      const url = new URL(`${this.baseUrl.toString().replace(/\/$/, '')}/me`);
      url.searchParams.set('$select', 'id,mail,userPrincipalName,displayName');
      const profile = await this.request(url, signal, parseProfile);
      return {
        connected: true,
        accountId: this.accountId,
        emailAddress: profile.emailAddress,
        displayName: profile.displayName,
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
    try {
      limit = boundedLimit(options.limit, 1000);
    } catch (error) {
      throw new MailProviderError({
        code: 'INVALID_REQUEST',
        provider: this.kind,
        message: 'Outlook 查询参数无效',
        cause: error,
      });
    }
    const cursorUrl = options.cursor ? this.decodeAndValidateCursor(options.cursor) : undefined;
    let url: URL;
    try {
      url = cursorUrl ?? this.initialDeltaUrl(limit, options.since);
    } catch (error) {
      if (error instanceof MailProviderError) throw error;
      throw new MailProviderError({
        code: 'INVALID_REQUEST',
        provider: this.kind,
        message: 'Outlook 查询参数无效',
        cause: error,
      });
    }
    const page = await this.request(url, options.signal, parseDeltaPage, Boolean(cursorUrl));
    const items = page.messages
      .filter(message => !message.removed)
      .map(toHeader);

    if (page.nextLink) {
      return { items, nextCursor: this.encodeValidatedCursor(page.nextLink) };
    }
    if (!page.deltaLink) {
      throw new MailProviderError({
        code: 'INVALID_RESPONSE',
        provider: this.kind,
        message: 'Outlook delta 响应缺少 @odata.nextLink 或 @odata.deltaLink',
      });
    }
    return { items, syncCursor: this.encodeValidatedCursor(page.deltaLink) };
  }

  async getMessage(messageId: string, signal?: AbortSignal): Promise<NormalizedEmail> {
    let id: string;
    try {
      id = nonEmptyOption(messageId, 'messageId');
    } catch (error) {
      throw new MailProviderError({
        code: 'INVALID_REQUEST',
        provider: this.kind,
        message: 'Outlook messageId 无效',
        cause: error,
      });
    }
    const url = new URL(
      `${this.baseUrl.toString().replace(/\/$/, '')}/me/messages/${encodeURIComponent(id)}`,
    );
    url.searchParams.set('$select', `${MESSAGE_SELECT},body`);
    const message = await this.request(url, signal, parseGraphMessage);
    if (message.removed) {
      throw new MailProviderError({
        code: 'NOT_FOUND',
        provider: this.kind,
        message: 'Outlook message 已删除',
      });
    }
    return {
      id: message.id,
      threadId: message.conversationId,
      accountId: this.accountId,
      provider: this.kind,
      from: message.sender,
      to: message.to,
      subject: message.subject,
      receivedAt: message.receivedAt,
      ...(message.body?.contentType === 'text' && message.body.content
        ? { text: message.body.content }
        : {}),
      ...(message.body?.contentType === 'html' && message.body.content
        ? { html: message.body.content }
        : {}),
    };
  }

  private initialDeltaUrl(limit: number, since?: string): URL {
    const url = new URL(
      `${this.baseUrl.toString().replace(/\/$/, '')}/me/mailFolders/inbox/messages/delta`,
    );
    url.searchParams.set('$select', MESSAGE_SELECT);
    url.searchParams.set('$top', String(limit));
    url.searchParams.set('changeType', 'created');
    if (since) url.searchParams.set('$filter', `receivedDateTime ge ${normalizeReceivedAt(since)}`);
    return url;
  }

  private encodeValidatedCursor(value: string): string {
    const url = this.validateGraphUrl(value);
    return `outlook:${encodeURIComponent(url.toString())}`;
  }

  private decodeAndValidateCursor(cursor: string): URL {
    try {
      if (!cursor.startsWith('outlook:')) throw new Error('wrong provider');
      return this.validateGraphUrl(decodeURIComponent(cursor.slice('outlook:'.length)));
    } catch (error) {
      if (error instanceof MailProviderError) throw error;
      throw new MailProviderError({
        code: 'INVALID_REQUEST',
        provider: this.kind,
        message: 'Outlook cursor 无效',
        cause: error,
      });
    }
  }

  private validateGraphUrl(value: string): URL {
    const url = new URL(value);
    const basePath = this.baseUrl.pathname.replace(/\/$/, '');
    if (
      url.protocol !== 'https:'
      || url.origin !== this.baseUrl.origin
      || (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`))
      || url.username
      || url.password
    ) {
      throw new MailProviderError({
        code: 'INVALID_REQUEST',
        provider: this.kind,
        message: 'Outlook cursor 指向了非 Microsoft Graph 地址',
      });
    }
    return url;
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
      scopes: OUTLOOK_SCOPES,
      tokenProvider: this.tokenProvider,
      fetch: this.fetcher,
      url: url.toString(),
      headers: { Prefer: IMMUTABLE_ID_PREFER },
      timeoutMs: this.timeoutMs,
      signal,
      cursorRequest,
      parse,
    });
  }
}

function parseProfile(value: unknown): { emailAddress: string; displayName?: string } {
  if (!isRecord(value)) throw new TypeError('profile must be an object');
  const emailAddress = optionalString(value.mail) ?? requiredString(value.userPrincipalName, 'userPrincipalName');
  return {
    emailAddress: emailAddress.toLowerCase(),
    displayName: optionalString(value.displayName),
  };
}

function parseDeltaPage(value: unknown): GraphDeltaPage {
  if (!isRecord(value) || !Array.isArray(value.value)) {
    throw new TypeError('delta response must contain value[]');
  }
  return {
    messages: value.value.map(parseGraphMessage),
    nextLink: optionalString(value['@odata.nextLink']),
    deltaLink: optionalString(value['@odata.deltaLink']),
  };
}

function parseGraphMessage(value: unknown): GraphMessage {
  if (!isRecord(value)) throw new TypeError('message must be an object');
  const id = requiredString(value.id, 'message.id');
  if (isRecord(value['@removed'])) {
    return {
      id,
      sender: { address: '' },
      to: [],
      subject: '',
      receivedAt: new Date(0).toISOString(),
      removed: true,
    };
  }
  const sender = parseGraphRecipient(value.sender, 'message.sender');
  const rawRecipients = value.toRecipients === undefined ? [] : value.toRecipients;
  if (!Array.isArray(rawRecipients)) throw new TypeError('message.toRecipients must be an array');
  const body = value.body === undefined ? undefined : parseGraphBody(value.body);
  return {
    id,
    conversationId: optionalString(value.conversationId),
    sender,
    to: rawRecipients.map((recipient, index) =>
      parseGraphRecipient(recipient, `message.toRecipients[${index}]`).address),
    subject: typeof value.subject === 'string' ? value.subject : '',
    receivedAt: normalizeReceivedAt(requiredString(value.receivedDateTime, 'message.receivedDateTime')),
    body,
    removed: false,
  };
}

function parseGraphRecipient(value: unknown, field: string): EmailAddress {
  if (!isRecord(value) || !isRecord(value.emailAddress)) {
    throw new TypeError(`${field} must contain emailAddress`);
  }
  const address = requiredString(value.emailAddress.address, `${field}.emailAddress.address`).toLowerCase();
  const name = optionalString(value.emailAddress.name);
  return { ...(name ? { name } : {}), address };
}

function parseGraphBody(value: unknown): GraphMessage['body'] {
  if (!isRecord(value)) throw new TypeError('message.body must be an object');
  const contentType = requiredString(value.contentType, 'message.body.contentType').toLowerCase();
  if (contentType !== 'text' && contentType !== 'html') {
    throw new TypeError('message.body.contentType must be text or html');
  }
  return {
    contentType,
    content: typeof value.content === 'string' ? value.content : '',
  };
}

function toHeader(message: GraphMessage): MailHeader {
  return {
    id: message.id,
    threadId: message.conversationId,
    from: formatEmailAddress(message.sender),
    to: message.to,
    subject: message.subject,
    receivedAt: message.receivedAt,
  };
}

function nonEmptyOption(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must not be empty`);
  return normalized;
}

function normalizeBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new TypeError('Outlook baseUrl must use HTTPS');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url;
}
