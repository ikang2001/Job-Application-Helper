import {
  MAX_LIST_MESSAGES,
  NATIVE_MAIL_PROTOCOL_VERSION,
  type AccountStore,
  type CredentialStore,
  type NativeMailAccountConfig,
  type NativeMailRequest,
  type NativeMailResponse,
} from './types.js';
import { ImapMailService, NativeMailServiceError } from './imapService.js';
import {
  LocalApplicationRecordsStore,
  LocalRecordsStoreError,
} from './localRecordsStore.js';

export interface NativeMailHandlerDependencies {
  accounts: AccountStore;
  credentials: CredentialStore;
  imap: ImapMailService;
  localRecords: LocalApplicationRecordsStore;
}

export async function handleNativeMailRequest(
  input: unknown,
  dependencies: NativeMailHandlerDependencies,
): Promise<NativeMailResponse> {
  const requestId = readRequestId(input);
  try {
    const request = parseNativeMailRequest(input);
    const data = await dispatch(request, dependencies);
    return {
      protocolVersion: NATIVE_MAIL_PROTOCOL_VERSION,
      requestId: request.requestId,
      success: true,
      data,
    };
  } catch (error) {
    const normalized = normalizeHandlerError(error);
    return {
      protocolVersion: NATIVE_MAIL_PROTOCOL_VERSION,
      requestId,
      success: false,
      error: normalized,
    };
  }
}

async function dispatch(
  request: NativeMailRequest,
  dependencies: NativeMailHandlerDependencies,
): Promise<unknown> {
  switch (request.type) {
    case 'PING':
      return { host: 'com.job_application_helper.mail', version: '1.1.0' };
    case 'MERGE_APPLICATION_RECORDS': {
      await dependencies.localRecords.merge({
        writer: request.writer,
        records: request.records,
        tombstones: request.tombstones,
      });
      return dependencies.localRecords.getMeta();
    }
    case 'GET_APPLICATION_RECORDS_META':
      return dependencies.localRecords.getMeta();
    case 'GET_APPLICATION_RECORDS_CHUNK':
      return dependencies.localRecords.readChunk(request.revision, request.index);
    case 'UPSERT_ACCOUNT':
      await dependencies.accounts.upsert(request.account);
      return { accountId: request.account.id };
    case 'SET_CREDENTIAL':
      await requireAccount(dependencies.accounts, request.accountId);
      await dependencies.credentials.set(request.accountId, request.credential);
      return { accountId: request.accountId };
    case 'DELETE_ACCOUNT':
      await dependencies.accounts.delete(request.accountId);
      await dependencies.credentials.delete(request.accountId);
      return { accountId: request.accountId };
    case 'TEST_CONNECTION': {
      const { account, credential } = await loadConnection(dependencies, request.accountId);
      await dependencies.imap.testConnection(account, credential);
      return { connected: true, accountId: request.accountId };
    }
    case 'LIST_MESSAGES': {
      const { account, credential } = await loadConnection(dependencies, request.accountId);
      return dependencies.imap.listMessages(account, credential, request);
    }
    case 'GET_MESSAGE': {
      const { account, credential } = await loadConnection(dependencies, request.accountId);
      return dependencies.imap.getMessage(account, credential, request.messageId);
    }
  }
}

async function loadConnection(
  dependencies: NativeMailHandlerDependencies,
  accountId: string,
): Promise<{ account: NativeMailAccountConfig; credential: string }> {
  const account = await requireAccount(dependencies.accounts, accountId);
  const credential = await dependencies.credentials.get(accountId);
  if (!credential) {
    throw new NativeMailServiceError('CREDENTIAL_NOT_FOUND', '邮箱授权码尚未保存', false);
  }
  return { account, credential };
}

async function requireAccount(store: AccountStore, accountId: string): Promise<NativeMailAccountConfig> {
  const account = await store.get(accountId);
  if (!account) throw new NativeMailServiceError('ACCOUNT_NOT_FOUND', '邮箱账号不存在', false);
  return account;
}

export function parseNativeMailRequest(input: unknown): NativeMailRequest {
  const value = requireRecord(input, '请求必须是对象');
  const requestId = requireShortString(value.requestId, 'requestId', 128);
  if (value.protocolVersion !== NATIVE_MAIL_PROTOCOL_VERSION) {
    throw new NativeMailServiceError('UNSUPPORTED_PROTOCOL', 'Native Mail 协议版本不兼容', false);
  }
  const type = requireShortString(value.type, 'type', 64);

  switch (type) {
    case 'PING':
      return { protocolVersion: 1, requestId, type };
    case 'MERGE_APPLICATION_RECORDS':
      return {
        protocolVersion: 1,
        requestId,
        type,
        writer: parseLocalRecordsWriter(value.writer),
        records: parseLocalApplicationRecords(value.records),
        tombstones: parseLocalApplicationRecordTombstones(value.tombstones),
      };
    case 'GET_APPLICATION_RECORDS_META':
      return { protocolVersion: 1, requestId, type };
    case 'GET_APPLICATION_RECORDS_CHUNK':
      return {
        protocolVersion: 1,
        requestId,
        type,
        revision: requireNonNegativeInteger(value.revision, 'revision'),
        index: requireNonNegativeInteger(value.index, 'index'),
      };
    case 'UPSERT_ACCOUNT':
      return { protocolVersion: 1, requestId, type, account: parseAccount(value.account) };
    case 'SET_CREDENTIAL':
      return {
        protocolVersion: 1,
        requestId,
        type,
        accountId: requireShortString(value.accountId, 'accountId', 128),
        credential: requireShortString(value.credential, 'credential', 4096),
      };
    case 'DELETE_ACCOUNT':
    case 'TEST_CONNECTION':
      return {
        protocolVersion: 1,
        requestId,
        type,
        accountId: requireShortString(value.accountId, 'accountId', 128),
      };
    case 'LIST_MESSAGES':
      return {
        protocolVersion: 1,
        requestId,
        type,
        accountId: requireShortString(value.accountId, 'accountId', 128),
        since: optionalIsoDate(value.since),
        cursor: parseCursor(value.cursor),
        limit: optionalLimit(value.limit),
      };
    case 'GET_MESSAGE':
      return {
        protocolVersion: 1,
        requestId,
        type,
        accountId: requireShortString(value.accountId, 'accountId', 128),
        messageId: requireShortString(value.messageId, 'messageId', 256),
      };
    default:
      throw new NativeMailServiceError('INVALID_REQUEST', `不支持的请求类型：${type}`, false);
  }
}

function parseLocalRecordsWriter(input: unknown): 'edge' | 'desktop' {
  if (input !== 'edge' && input !== 'desktop') {
    throw new NativeMailServiceError('INVALID_REQUEST', 'writer 必须是 edge 或 desktop', false);
  }
  return input;
}

function parseLocalApplicationRecords(
  input: unknown,
): Array<Record<string, unknown> & { id: string; updatedAt: string }> {
  if (!Array.isArray(input)) {
    throw new NativeMailServiceError('INVALID_REQUEST', 'records 必须是数组', false);
  }
  return input.map((item, index) => {
    const record = requireRecord(item, `records[${index}] 必须是对象`);
    return {
      ...record,
      id: requireShortString(record.id, `records[${index}].id`, 512),
      updatedAt: localRecordUpdatedAt(record),
    };
  });
}

function parseLocalApplicationRecordTombstones(
  input: unknown,
): Array<{ id: string; deletedAt: string }> {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    throw new NativeMailServiceError('INVALID_REQUEST', 'tombstones 必须是数组', false);
  }
  return input.map((item, index) => {
    const tombstone = requireRecord(item, `tombstones[${index}] 必须是对象`);
    return {
      id: requireShortString(tombstone.id, `tombstones[${index}].id`, 512),
      deletedAt: requireIsoDate(tombstone.deletedAt, `tombstones[${index}].deletedAt`),
    };
  });
}

function requireNonNegativeInteger(input: unknown, name: string): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 0) {
    throw new NativeMailServiceError('INVALID_REQUEST', `${name} 必须是非负整数`, false);
  }
  return input;
}

function requireIsoDate(input: unknown, name: string): string {
  const value = requireShortString(input, name, 64);
  if (!Number.isFinite(Date.parse(value))) {
    throw new NativeMailServiceError('INVALID_REQUEST', `${name} 必须是有效时间`, false);
  }
  return value;
}

function localRecordUpdatedAt(record: Record<string, unknown>): string {
  for (const value of [record.updatedAt, record.createdAt, record.appliedAt]) {
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
      return new Date(value).toISOString();
    }
  }
  return new Date(0).toISOString();
}

function parseAccount(input: unknown): NativeMailAccountConfig {
  const value = requireRecord(input, 'account 必须是对象');
  const provider = requireShortString(value.provider, 'provider', 16);
  if (!['qq', '163', '126', 'imap'].includes(provider)) {
    throw new NativeMailServiceError('INVALID_REQUEST', '不支持的 IMAP provider', false);
  }
  const port = typeof value.port === 'number' ? Math.trunc(value.port) : 0;
  if (port < 1 || port > 65535) {
    throw new NativeMailServiceError('INVALID_REQUEST', 'IMAP port 必须在 1-65535 之间', false);
  }
  if (value.secure !== true) {
    throw new NativeMailServiceError('INVALID_REQUEST', 'IMAP 必须启用 TLS', false);
  }
  return {
    id: requireShortString(value.id, 'account.id', 128),
    provider: provider as NativeMailAccountConfig['provider'],
    emailAddress: requireEmail(value.emailAddress),
    displayName: optionalShortString(value.displayName, 128),
    host: requireHost(value.host),
    port,
    secure: true,
    username: requireShortString(value.username, 'account.username', 320),
  };
}

function parseCursor(input: unknown): { uidValidity: string; lastUid: number } | undefined {
  if (input === undefined) return undefined;
  const value = requireRecord(input, 'cursor 必须是对象');
  const lastUid = typeof value.lastUid === 'number' ? Math.trunc(value.lastUid) : -1;
  if (lastUid < 0) throw new NativeMailServiceError('INVALID_REQUEST', 'cursor.lastUid 无效', false);
  return {
    uidValidity: requireShortString(value.uidValidity, 'cursor.uidValidity', 64),
    lastUid,
  };
}

function optionalLimit(input: unknown): number | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new NativeMailServiceError('INVALID_REQUEST', 'limit 必须是数字', false);
  }
  return Math.max(1, Math.min(MAX_LIST_MESSAGES, Math.trunc(input)));
}

function optionalIsoDate(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  const value = requireShortString(input, 'since', 64);
  if (Number.isNaN(Date.parse(value))) {
    throw new NativeMailServiceError('INVALID_REQUEST', 'since 必须是有效时间', false);
  }
  return value;
}

function requireEmail(input: unknown): string {
  const value = requireShortString(input, 'emailAddress', 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new NativeMailServiceError('INVALID_REQUEST', '邮箱地址格式无效', false);
  }
  return value;
}

function requireHost(input: unknown): string {
  const value = requireShortString(input, 'host', 253).toLowerCase();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new NativeMailServiceError('INVALID_REQUEST', 'IMAP host 格式无效', false);
  }
  return value;
}

function requireRecord(input: unknown, message: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new NativeMailServiceError('INVALID_REQUEST', message, false);
  }
  return input as Record<string, unknown>;
}

function requireShortString(input: unknown, name: string, maxLength: number): string {
  if (typeof input !== 'string' || !input.trim() || input.length > maxLength) {
    throw new NativeMailServiceError('INVALID_REQUEST', `${name} 必须是 1-${maxLength} 字符的字符串`, false);
  }
  return input.trim();
}

function optionalShortString(input: unknown, maxLength: number): string | undefined {
  if (input === undefined || input === '') return undefined;
  return requireShortString(input, 'displayName', maxLength);
}

function readRequestId(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'unknown';
  const value = (input as Record<string, unknown>).requestId;
  return typeof value === 'string' && value.length <= 128 ? value : 'unknown';
}

function normalizeHandlerError(error: unknown): NonNullable<NativeMailResponse['error']> {
  if (error instanceof LocalRecordsStoreError) {
    return { code: error.code, message: error.message, retryable: error.code === 'STALE_REVISION' };
  }
  if (error instanceof NativeMailServiceError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : 'Native Mail 内部错误',
    retryable: false,
  };
}
