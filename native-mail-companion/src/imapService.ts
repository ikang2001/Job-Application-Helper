import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import {
  MAX_LIST_MESSAGES,
  MAX_MESSAGE_TEXT_BYTES,
  type ImapCursor,
  type ListMessagesResult,
  type NativeMailAccountConfig,
  type NativeMailHeader,
  type NativeNormalizedEmail,
} from './types.js';
import { NativeMailServiceError, normalizeImapError } from './mailErrors.js';
import type { MailLease, MailRuntime } from './mailRuntime.js';
export { NativeMailServiceError } from './mailErrors.js';

const UID_RECHECK_WINDOW = 50;

interface AddressLike {
  name?: string;
  address?: string;
}

interface EnvelopeLike {
  subject?: string;
  messageId?: string;
  date?: Date;
  from?: AddressLike[];
  to?: AddressLike[];
}

interface FetchMessageLike {
  uid: number;
  threadId?: string;
  envelope?: EnvelopeLike;
  internalDate?: Date;
  size?: number;
  source?: Buffer;
}

interface MailboxLike {
  uidValidity: bigint;
  uidNext?: number;
  exists: number;
}

interface MailboxLockLike {
  release(): void;
}

export interface ImapClientPort {
  mailbox: MailboxLike | false;
  connect(): Promise<void>;
  logout(): Promise<void>;
  close?(): void;
  getMailboxLock(path: string): Promise<MailboxLockLike>;
  search(query: { since?: Date; uid?: string }, options: { uid: true }): Promise<number[]>;
  fetchAll(
    range: string | number[],
    query: { uid?: boolean; envelope?: boolean; internalDate?: boolean; size?: boolean },
    options: { uid: true },
  ): Promise<FetchMessageLike[]>;
  fetchOne(
    uid: string | number,
    query: {
      uid?: boolean;
      envelope?: boolean;
      internalDate?: boolean;
      size?: boolean;
      source?: boolean | { start: number; maxLength: number };
    },
    options: { uid: true },
  ): Promise<FetchMessageLike | false>;
}

export type ImapClientFactory = (
  account: NativeMailAccountConfig,
  credential: string,
) => ImapClientPort;

export class ImapMailService {
  private readonly sessions = new Map<string, { client: ImapClientPort; lease?: MailLease }>();
  private readonly failedSessions = new Map<string, NativeMailServiceError>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly createClient: ImapClientFactory = createImapClient,
    private readonly runtime?: MailRuntime,
  ) {}

  beginSession(account: NativeMailAccountConfig, credential: string): Promise<void> {
    return this.serialize(async () => {
      if (this.sessions.has(account.id)) return;
      this.failedSessions.delete(account.id);
      const lease = await this.runtime?.acquire(account);
      const client = this.createClient(account, credential);
      try {
        await client.connect();
        this.sessions.set(account.id, { client, lease });
      } catch (error) {
        client.close?.();
        try { throw await this.connectionError(error, lease); }
        finally { await lease?.release(); }
      }
    });
  }

  endSession(accountId: string): Promise<void> {
    return this.serialize(async () => { this.failedSessions.delete(accountId); await this.releaseSession(accountId); });
  }

  async close(): Promise<void> {
    await this.serialize(async () => {
      for (const accountId of this.sessions.keys()) await this.releaseSession(accountId);
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async releaseSession(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId);
    if (!session) return;
    this.sessions.delete(accountId);
    try { await session.client.logout(); }
    catch { session.client.close?.(); }
    finally { await session.lease?.release(); }
  }

  private async connectionError(error: unknown, lease?: MailLease): Promise<NativeMailServiceError> {
    const normalized = normalizeImapError(error);
    return normalized.code === 'RATE_LIMITED' && lease ? lease.limited() : normalized;
  }

  async testConnection(account: NativeMailAccountConfig, credential: string): Promise<void> {
    await this.withClient(account, credential, async () => undefined);
  }

  async listMessages(
    account: NativeMailAccountConfig,
    credential: string,
    options: { since?: string; cursor?: ImapCursor; limit?: number },
  ): Promise<ListMessagesResult> {
    return this.withClient(account, credential, async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const mailbox = requireMailbox(client.mailbox);
        const uidValidity = mailbox.uidValidity.toString();
        const limit = clampLimit(options.limit);
        const cursorMatches = options.cursor?.uidValidity === uidValidity;
        const previousUid = cursorMatches ? options.cursor?.lastUid ?? 0 : 0;
        const selection = await selectMessageUids(client, mailbox, previousUid, options.since, limit);
        const fetched = selection.uids.length === 0
          ? []
          : await client.fetchAll(selection.uids, {
              uid: true,
              envelope: true,
              internalDate: true,
              size: true,
            }, { uid: true });
        const messages = fetched
          .map(toHeader)
          .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
        const lastUid = messages.reduce(
          (maximum, message) => Math.max(maximum, Number(message.id) || 0),
          selection.scannedThroughUid,
        );
        return {
          messages,
          cursor: { uidValidity, lastUid },
          hasMore: selection.hasMore,
        };
      } finally {
        lock.release();
      }
    });
  }

  async getMessage(
    account: NativeMailAccountConfig,
    credential: string,
    messageId: string,
  ): Promise<NativeNormalizedEmail> {
    return this.withClient(account, credential, async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const fetched = await client.fetchOne(messageId, {
          uid: true,
          envelope: true,
          internalDate: true,
          size: true,
          source: { start: 0, maxLength: MAX_MESSAGE_TEXT_BYTES },
        }, { uid: true });
        if (!fetched || !fetched.source) {
          throw new NativeMailServiceError('MESSAGE_NOT_FOUND', '邮件不存在或已被移动', false);
        }

        const parsed = await simpleParser(fetched.source, {
          skipHtmlToText: false,
          skipTextToHtml: true,
          skipImageLinks: true,
        });
        const header = toHeader(fetched);
        const body = parsed.text?.trim() || htmlToText(typeof parsed.html === 'string' ? parsed.html : '');
        const truncatedBody = truncateUtf8(body, MAX_MESSAGE_TEXT_BYTES);
        return {
          ...header,
          accountId: account.id,
          provider: 'imap',
          from: firstAddress(parsed.from?.value) ?? header.from,
          to: addressList(parsed.to),
          subject: parsed.subject?.trim() || header.subject,
          text: truncatedBody.text,
          truncated: truncatedBody.truncated || (fetched.size ?? 0) > MAX_MESSAGE_TEXT_BYTES,
        };
      } catch (error) {
        if (error instanceof NativeMailServiceError) throw error;
        throw normalizeImapError(error);
      } finally {
        lock.release();
      }
    });
  }

  private async withClient<T>(
    account: NativeMailAccountConfig,
    credential: string,
    run: (client: ImapClientPort) => Promise<T>,
  ): Promise<T> {
    return this.serialize(() => this.runWithClient(account, credential, run));
  }

  private async runWithClient<T>(
    account: NativeMailAccountConfig,
    credential: string,
    run: (client: ImapClientPort) => Promise<T>,
  ): Promise<T> {
    const failure = this.failedSessions.get(account.id);
    if (failure) throw failure;
    const session = this.sessions.get(account.id);
    if (session) {
      try {
        const result = await run(session.client);
        await session.lease?.success();
        return result;
      } catch (error) {
        try {
          const failure = await this.connectionError(error, session.lease);
          this.failedSessions.set(account.id, failure);
          throw failure;
        }
        finally { await this.releaseSession(account.id); }
      }
    }
    const lease = await this.runtime?.acquire(account);
    const client = this.createClient(account, credential);
    let connected = false;
    try {
      await client.connect();
      connected = true;
      const result = await run(client);
      await lease?.success();
      return result;
    } catch (error) {
      throw await this.connectionError(error, lease);
    } finally {
      if (connected) {
        try {
          await client.logout();
        } catch {
          // The connection may already be closed; the original operation result wins.
        }
      }
      client.close?.();
      await lease?.release();
    }
  }
}

function createImapClient(account: NativeMailAccountConfig, credential: string): ImapClientPort {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: { user: account.username, pass: credential },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return client as unknown as ImapClientPort;
}

function requireMailbox(mailbox: MailboxLike | false): MailboxLike {
  if (!mailbox) throw new NativeMailServiceError('CONNECTION_FAILED', 'INBOX 未成功打开', true);
  return mailbox;
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 50;
  return Math.max(1, Math.min(MAX_LIST_MESSAGES, Math.trunc(value as number)));
}

async function selectMessageUids(
  client: ImapClientPort,
  mailbox: MailboxLike,
  previousUid: number,
  since: string | undefined,
  limit: number,
): Promise<{ uids: number[]; hasMore: boolean; scannedThroughUid: number }> {
  const recheckFloor = previousUid > UID_RECHECK_WINDOW
    ? previousUid - UID_RECHECK_WINDOW
    : previousUid;
  const query = previousUid > 0
    ? { uid: `${recheckFloor + 1}:*` }
    : { since: parseSince(since) };
  const found = (await client.search(query, { uid: true }))
    .filter(uid => Number.isSafeInteger(uid) && uid > recheckFloor)
    .sort((left, right) => left - right);
  const newUids = found.filter(uid => uid > previousUid);
  const selectedNew = newUids.slice(0, limit);
  const overlapCapacity = limit - selectedNew.length;
  const selectedOverlap = previousUid > 0 && overlapCapacity > 0
    ? found.filter(uid => uid <= previousUid).slice(-overlapCapacity)
    : [];
  const selected = [...selectedOverlap, ...selectedNew].sort((left, right) => left - right);
  const highestUid = Number.isSafeInteger(mailbox.uidNext)
    ? Math.max(previousUid, (mailbox.uidNext as number) - 1)
    : previousUid;
  return {
    uids: selected,
    hasMore: newUids.length > selectedNew.length,
    scannedThroughUid: selectedNew.at(-1) ?? highestUid,
  };
}

function parseSince(value: string | undefined): Date {
  if (value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
}

function toHeader(message: FetchMessageLike): NativeMailHeader {
  const envelope = message.envelope;
  return {
    id: String(message.uid),
    messageId: envelope?.messageId?.trim() || undefined,
    threadId: message.threadId,
    from: firstAddress(envelope?.from) ?? { address: '' },
    to: (envelope?.to ?? []).map(address => address.address?.trim()).filter(isNonEmpty),
    subject: envelope?.subject?.trim() || '',
    receivedAt: (envelope?.date ?? message.internalDate ?? new Date(0)).toISOString(),
    size: message.size,
  };
}

function firstAddress(value: AddressLike[] | undefined): { name?: string; address: string } | null {
  const first = value?.find(item => item.address?.trim());
  if (!first?.address) return null;
  return { name: first.name?.trim() || undefined, address: first.address.trim() };
}

function addressList(value: unknown): string[] {
  if (!value) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || !('value' in entry) || !Array.isArray(entry.value)) return [];
    return entry.value
      .map((address: unknown) => (
        address && typeof address === 'object' && 'address' in address
          ? address.address
          : ''
      ))
      .filter((address: unknown): address is string => (
        typeof address === 'string' && address.trim().length > 0
      ))
      .map((address: string) => address.trim());
  });
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 0b10) end -= 1;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

function isNonEmpty(value: string | undefined): value is string {
  return Boolean(value);
}
