export const NATIVE_MAIL_PROTOCOL_VERSION = 1 as const;
export const NATIVE_MAIL_HOST_NAME = 'com.job_application_helper.mail';
export const MAX_LIST_MESSAGES = 100;
export const MAX_MESSAGE_TEXT_BYTES = 256 * 1024;

export type NativeMailProviderType = 'qq' | '163' | '126' | 'imap';

export interface NativeMailAccountConfig {
  id: string;
  provider: NativeMailProviderType;
  emailAddress: string;
  displayName?: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
}

export interface ImapCursor {
  uidValidity: string;
  lastUid: number;
}

export interface NativeMailHeader {
  id: string;
  messageId?: string;
  threadId?: string;
  from: { name?: string; address: string };
  to: string[];
  subject: string;
  receivedAt: string;
  size?: number;
}

export interface NativeNormalizedEmail extends NativeMailHeader {
  accountId: string;
  provider: 'imap';
  text: string;
  truncated: boolean;
}

export type NativeMailRequest =
  | { protocolVersion: 1; requestId: string; type: 'PING' }
  | {
      protocolVersion: 1;
      requestId: string;
      type: 'MERGE_APPLICATION_RECORDS';
      writer: 'edge' | 'desktop';
      records: Array<Record<string, unknown> & { id: string; updatedAt: string }>;
      tombstones: Array<{ id: string; deletedAt: string }>;
    }
  | { protocolVersion: 1; requestId: string; type: 'GET_APPLICATION_RECORDS_META' }
  | {
      protocolVersion: 1;
      requestId: string;
      type: 'GET_APPLICATION_RECORDS_CHUNK';
      revision: number;
      index: number;
    }
  | { protocolVersion: 1; requestId: string; type: 'UPSERT_ACCOUNT'; account: NativeMailAccountConfig }
  | { protocolVersion: 1; requestId: string; type: 'SET_CREDENTIAL'; accountId: string; credential: string }
  | { protocolVersion: 1; requestId: string; type: 'DELETE_ACCOUNT'; accountId: string }
  | { protocolVersion: 1; requestId: string; type: 'TEST_CONNECTION'; accountId: string }
  | {
      protocolVersion: 1;
      requestId: string;
      type: 'LIST_MESSAGES';
      accountId: string;
      since?: string;
      cursor?: ImapCursor;
      limit?: number;
    }
  | { protocolVersion: 1; requestId: string; type: 'GET_MESSAGE'; accountId: string; messageId: string };

export type NativeMailErrorCode =
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_PROTOCOL'
  | 'ACCOUNT_NOT_FOUND'
  | 'CREDENTIAL_NOT_FOUND'
  | 'AUTH_FAILED'
  | 'CONNECTION_FAILED'
  | 'TIMEOUT'
  | 'MESSAGE_NOT_FOUND'
  | 'MESSAGE_TOO_LARGE'
  | 'STALE_REVISION'
  | 'INTERNAL_ERROR';

export interface NativeMailResponse<T = unknown> {
  protocolVersion: 1;
  requestId: string;
  success: boolean;
  data?: T;
  error?: {
    code: NativeMailErrorCode;
    message: string;
    retryable: boolean;
  };
}

export interface ListMessagesResult {
  messages: NativeMailHeader[];
  cursor: ImapCursor;
  hasMore: boolean;
}

export interface CredentialStore {
  get(accountId: string): Promise<string | null>;
  set(accountId: string, credential: string): Promise<void>;
  delete(accountId: string): Promise<void>;
}

export interface AccountStore {
  get(accountId: string): Promise<NativeMailAccountConfig | null>;
  upsert(account: NativeMailAccountConfig): Promise<void>;
  delete(accountId: string): Promise<void>;
}
