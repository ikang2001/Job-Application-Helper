import type { OAuthTokenProvider, OAuthTokenRequest } from './accounts.ts';
import {
  MailProviderError,
  type FetchLike,
  type MailProviderErrorCode,
} from './provider.ts';
import type { MailProviderKind } from './types.ts';

export const DEFAULT_MAIL_REQUEST_TIMEOUT_MS = 15_000;

interface AuthenticatedJsonRequest<T> {
  provider: Extract<MailProviderKind, 'gmail' | 'outlook'>;
  accountId: string;
  scopes: readonly string[];
  tokenProvider: OAuthTokenProvider;
  fetch: FetchLike;
  url: string;
  headers?: HeadersInit;
  signal?: AbortSignal;
  timeoutMs?: number;
  cursorRequest?: boolean;
  parse(value: unknown): T;
}

export async function authenticatedJson<T>(request: AuthenticatedJsonRequest<T>): Promise<T> {
  const tokenRequest: OAuthTokenRequest = {
    provider: request.provider,
    accountId: request.accountId,
    scopes: request.scopes,
  };
  let accessToken: string;
  try {
    const token = await request.tokenProvider.getAccessToken(tokenRequest);
    accessToken = token.accessToken.trim();
  } catch (error) {
    throw new MailProviderError({
      code: 'AUTH_REQUIRED',
      provider: request.provider,
      message: `${providerLabel(request.provider)} OAuth token 获取失败`,
      cause: error,
    });
  }
  if (!accessToken) {
    throw new MailProviderError({
      code: 'AUTH_REQUIRED',
      provider: request.provider,
      message: `${providerLabel(request.provider)} OAuth token 为空`,
    });
  }

  const timeoutMs = request.timeoutMs ?? DEFAULT_MAIL_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (request.signal?.aborted) controller.abort();
  else request.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await request.fetch(request.url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...request.headers,
      },
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      if (response.status === 401) {
        try {
          await request.tokenProvider.invalidateAccessToken?.(tokenRequest, accessToken);
        } catch {
          // Token cache cleanup is best-effort; preserve the original HTTP classification.
        }
      }
      const classification = classifyHttpFailure(
        response.status,
        raw,
        Boolean(request.cursorRequest),
      );
      throw new MailProviderError({
        code: classification.code,
        provider: request.provider,
        retryable: classification.retryable,
        status: response.status,
        message: `${providerLabel(request.provider)} API ${response.status}: ${errorMessage(raw)}`,
      });
    }

    let value: unknown;
    try {
      value = raw ? JSON.parse(raw) : null;
    } catch (error) {
      throw new MailProviderError({
        code: 'INVALID_RESPONSE',
        provider: request.provider,
        message: `${providerLabel(request.provider)} API 返回的不是有效 JSON`,
        cause: error,
      });
    }
    try {
      return request.parse(value);
    } catch (error) {
      if (error instanceof MailProviderError) throw error;
      throw new MailProviderError({
        code: 'INVALID_RESPONSE',
        provider: request.provider,
        message: `${providerLabel(request.provider)} API 返回结构无效`,
        cause: error,
      });
    }
  } catch (error) {
    if (error instanceof MailProviderError) throw error;
    if (timedOut) {
      throw new MailProviderError({
        code: 'TIMEOUT',
        provider: request.provider,
        retryable: true,
        message: `${providerLabel(request.provider)} API 请求超时`,
        cause: error,
      });
    }
    if (request.signal?.aborted) {
      throw new MailProviderError({
        code: 'CANCELLED',
        provider: request.provider,
        message: `${providerLabel(request.provider)} API 请求已取消`,
        cause: error,
      });
    }
    throw new MailProviderError({
      code: 'NETWORK_ERROR',
      provider: request.provider,
      retryable: true,
      message: `${providerLabel(request.provider)} API 网络请求失败`,
      cause: error,
    });
  } finally {
    clearTimeout(timeoutId);
    request.signal?.removeEventListener('abort', abortFromCaller);
  }
}

function classifyHttpFailure(
  status: number,
  body: string,
  cursorRequest: boolean,
): { code: MailProviderErrorCode; retryable: boolean } {
  if (status === 401) return { code: 'AUTH_REQUIRED', retryable: false };
  if ((status === 404 || status === 410) && cursorRequest) {
    return { code: 'CURSOR_EXPIRED', retryable: false };
  }
  if (status === 403 && /rate|quota|limit/i.test(body)) {
    return { code: 'RATE_LIMITED', retryable: true };
  }
  if (status === 403) return { code: 'PERMISSION_DENIED', retryable: false };
  if (status === 404) return { code: 'NOT_FOUND', retryable: false };
  if (status === 429) return { code: 'RATE_LIMITED', retryable: true };
  if (status === 408 || status >= 500) return { code: 'SERVICE_UNAVAILABLE', retryable: true };
  return { code: 'INVALID_REQUEST', retryable: false };
}

function errorMessage(raw: string): string {
  if (!raw) return 'empty response';
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const direct = typeof value.message === 'string' ? value.message : undefined;
    const error = isRecord(value.error) ? value.error : undefined;
    return direct
      ?? (typeof error?.message === 'string' ? error.message : undefined)
      ?? raw.slice(0, 300);
  } catch {
    return raw.slice(0, 300);
  }
}

function providerLabel(provider: Extract<MailProviderKind, 'gmail' | 'outlook'>): string {
  return provider === 'gmail' ? 'Gmail' : 'Outlook';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function boundedLimit(limit: number, maximum: number): number {
  if (!Number.isInteger(limit) || limit <= 0) throw new TypeError('limit must be a positive integer');
  return Math.min(limit, maximum);
}
