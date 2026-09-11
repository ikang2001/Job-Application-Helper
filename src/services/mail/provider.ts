import type { OAuthTokenProvider } from './accounts.ts';
import type {
  MailConnectionResult,
  MailHeader,
  MailPage,
  MailProviderKind,
  MailQueryOptions,
  NormalizedEmail,
} from './types.ts';

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface MailProvider {
  readonly kind: MailProviderKind;
  readonly accountId: string;

  testConnection(signal?: AbortSignal): Promise<MailConnectionResult>;
  listHeaders(options: MailQueryOptions): Promise<MailPage<MailHeader>>;
  getMessage(messageId: string, signal?: AbortSignal): Promise<NormalizedEmail>;
}

export type MailProviderErrorCode =
  | 'AUTH_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'CURSOR_EXPIRED'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INVALID_RESPONSE';

export class MailProviderError extends Error {
  readonly code: MailProviderErrorCode;
  readonly provider: MailProviderKind;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(options: {
    code: MailProviderErrorCode;
    provider: MailProviderKind;
    message: string;
    retryable?: boolean;
    status?: number;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = 'MailProviderError';
    this.code = options.code;
    this.provider = options.provider;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

export interface RemoteMailProviderOptions {
  accountId: string;
  tokenProvider: OAuthTokenProvider;
  fetch?: FetchLike;
  timeoutMs?: number;
  baseUrl?: string;
}
