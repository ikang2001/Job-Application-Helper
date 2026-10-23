import type { MailAccount } from '../accounts.ts';
import { NativePortClient, type NativeResponse } from './nativePort.ts';
import {
  MailProviderError,
  type MailProvider,
} from '../provider.ts';
import type {
  MailConnectionResult,
  MailHeader,
  MailPage,
  MailQueryOptions,
  NormalizedEmail,
} from '../types.ts';

export const NATIVE_MAIL_HOST_NAME = 'com.job_application_helper.mail';

interface NativeHeader {
  id: string;
  threadId?: string;
  from: { name?: string; address: string };
  to: string[];
  subject: string;
  receivedAt: string;
}

interface NativeEmail extends NativeHeader {
  accountId: string;
  provider: 'imap';
  text: string;
  truncated: boolean;
}

interface NativeListResult {
  messages: NativeHeader[];
  cursor: { uidValidity: string; lastUid: number };
  hasMore: boolean;
}

export type NativeMessenger = <T>(message: Record<string, unknown>) => Promise<NativeResponse<T>>;

export class NativeImapProvider implements MailProvider {
  readonly kind = 'imap' as const;
  readonly accountId: string;
  private port?: NativePortClient;

  constructor(
    private readonly account: MailAccount,
    private readonly send: NativeMessenger = sendNativeMessage,
  ) {
    this.accountId = account.id;
  }

  async beginScan(): Promise<void> {
    if (this.send === sendNativeMessage) {
      try { this.port = new NativePortClient(chrome.runtime.connectNative(NATIVE_MAIL_HOST_NAME)); }
      catch (cause) {
        throw new MailProviderError({ code: 'SERVICE_UNAVAILABLE', provider: 'imap', message: '本地邮箱组件未安装或不可用', cause });
      }
    }
    try {
      const ping = await this.request<{ capabilities?: string[] }>({ type: 'PING' });
      if (!ping.capabilities?.includes('imap-session-v1')) {
        throw this.invalid('请先升级本地邮箱组件至 1.1.2 或更高版本（无需重新授权）');
      }
      await this.request({ type: 'BEGIN_SESSION', accountId: this.accountId });
    } catch (error) { this.port?.close(); this.port = undefined; throw error; }
  }

  async endScan(): Promise<void> {
    try { if (this.port || this.send !== sendNativeMessage) await this.request({ type: 'END_SESSION', accountId: this.accountId }); }
    catch { this.port?.close(); }
    finally { this.port?.close(); this.port = undefined; }
  }

  async testConnection(): Promise<MailConnectionResult> {
    try {
      await this.request<{ connected: boolean }>({ type: 'TEST_CONNECTION', accountId: this.accountId });
      return { connected: true, accountId: this.accountId, emailAddress: this.account.emailAddress };
    } catch (error) {
      if (!(error instanceof MailProviderError)) throw error;
      return { connected: false, accountId: this.accountId, errorCode: error.code, message: error.message, retryAt: error.retryAt };
    }
  }

  async listHeaders(options: MailQueryOptions): Promise<MailPage<MailHeader>> {
    const result = await this.request<NativeListResult>({
      type: 'LIST_MESSAGES',
      accountId: this.accountId,
      since: options.since,
      cursor: decodeCursor(options.cursor),
      limit: options.limit,
    });
    const cursor = encodeCursor(result.cursor);
    return {
      items: result.messages.map(message => ({
        ...message,
        from: message.from.name
          ? `${message.from.name} <${message.from.address}>`
          : message.from.address,
      })),
      ...(result.hasMore ? { nextCursor: cursor } : { syncCursor: cursor }),
    };
  }

  async getMessage(messageId: string): Promise<NormalizedEmail> {
    const email = await this.request<NativeEmail>({
      type: 'GET_MESSAGE',
      accountId: this.accountId,
      messageId,
    });
    return {
      id: email.id,
      threadId: email.threadId,
      accountId: this.accountId,
      provider: this.kind,
      from: email.from,
      to: email.to,
      subject: email.subject,
      receivedAt: email.receivedAt,
      text: email.text,
    };
  }

  async upsertNativeAccount(credential?: string): Promise<void> {
    if (!this.account.imap) throw this.invalid('IMAP 账号配置缺失');
    await this.request({
      type: 'UPSERT_ACCOUNT',
      account: {
        id: this.account.id,
        provider: this.account.imap.provider,
        emailAddress: this.account.emailAddress,
        displayName: this.account.displayName,
        host: this.account.imap.host,
        port: this.account.imap.port,
        secure: true,
        username: this.account.imap.username,
      },
    });
    if (credential?.trim()) {
      await this.request({
        type: 'SET_CREDENTIAL',
        accountId: this.account.id,
        credential: credential.trim(),
      });
    }
  }

  async deleteNativeAccount(): Promise<void> {
    await this.request({ type: 'DELETE_ACCOUNT', accountId: this.account.id });
  }

  private async request<T = unknown>(payload: Record<string, unknown>): Promise<T> {
    const message = {
      protocolVersion: 1,
      requestId: createRequestId(),
      ...payload,
    };
    const response = this.port ? await this.port.send<T>(message) : await this.send<T>(message);
    if (!response.success || response.data === undefined) {
      throw new MailProviderError({
        code: mapNativeError(response.error?.code),
        provider: this.kind,
        message: response.error?.message || '本地邮箱组件调用失败',
        retryable: response.error?.retryable,
        retryAt: response.error?.retryAt,
      });
    }
    return response.data;
  }

  private invalid(message: string): MailProviderError {
    return new MailProviderError({ code: 'INVALID_REQUEST', provider: this.kind, message });
  }
}

async function sendNativeMessage<T>(message: Record<string, unknown>): Promise<NativeResponse<T>> {
  try {
    return await chrome.runtime.sendNativeMessage(NATIVE_MAIL_HOST_NAME, message) as NativeResponse<T>;
  } catch (error) {
    throw new MailProviderError({
      code: 'SERVICE_UNAVAILABLE',
      provider: 'imap',
      message: /host.*not found|not registered/i.test(error instanceof Error ? error.message : '')
        ? '本地邮箱组件未安装'
        : error instanceof Error ? error.message : '无法连接本地邮箱组件',
      retryable: false,
      cause: error,
    });
  }
}

function encodeCursor(cursor: { uidValidity: string; lastUid: number }): string {
  return `imap:${encodeURIComponent(JSON.stringify(cursor))}`;
}

function decodeCursor(value: string | undefined): { uidValidity: string; lastUid: number } | undefined {
  if (!value) return undefined;
  try {
    if (!value.startsWith('imap:')) throw new Error('wrong provider');
    const parsed = JSON.parse(decodeURIComponent(value.slice(5))) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid cursor');
    const record = parsed as Record<string, unknown>;
    if (typeof record.uidValidity !== 'string' || typeof record.lastUid !== 'number') throw new Error('invalid cursor');
    return { uidValidity: record.uidValidity, lastUid: Math.max(0, Math.trunc(record.lastUid)) };
  } catch (error) {
    throw new MailProviderError({
      code: 'INVALID_REQUEST',
      provider: 'imap',
      message: 'IMAP cursor 无效',
      cause: error,
    });
  }
}

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `native-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function mapNativeError(code: string | undefined): MailProviderError['code'] {
  switch (code) {
    case 'RATE_LIMITED': return 'RATE_LIMITED';
    case 'ACCOUNT_BUSY': return 'ACCOUNT_BUSY';
    case 'AUTH_FAILED':
    case 'CREDENTIAL_NOT_FOUND': return 'AUTH_REQUIRED';
    case 'ACCOUNT_NOT_FOUND': return 'NOT_FOUND';
    case 'TIMEOUT': return 'TIMEOUT';
    case 'INVALID_REQUEST':
    case 'UNSUPPORTED_PROTOCOL': return 'INVALID_REQUEST';
    case 'MESSAGE_NOT_FOUND': return 'NOT_FOUND';
    default: return 'SERVICE_UNAVAILABLE';
  }
}
