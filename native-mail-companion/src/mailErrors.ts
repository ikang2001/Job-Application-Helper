import type { NativeMailErrorCode } from './types.js';

export class NativeMailServiceError extends Error {
  constructor(
    readonly code: NativeMailErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly retryAt?: string,
  ) {
    super(message);
    this.name = 'NativeMailServiceError';
  }
}

export function normalizeImapError(error: unknown): NativeMailServiceError {
  if (error instanceof NativeMailServiceError) return error;
  const details = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const message = [details.message, details.responseText, details.response, details.serverResponseCode, details.code]
    .filter(value => typeof value === 'string').join(' ');
  // 163 会同时返回 authenticationFailed 和 ALERT，必须先判断限流，不能提示换授权码。
  if (/too many|rate.?limit|try again later|login.*(?:limit|frequent)|频繁|限流/i.test(message)) {
    return new NativeMailServiceError('RATE_LIMITED', '邮箱服务器限制登录频率，正在等待自动重试，无需重新授权', true);
  }
  if (/timeout|timed out|required time|ETIMEDOUT/i.test(message)) {
    return new NativeMailServiceError('TIMEOUT', '邮箱连接超时，请检查网络后重试', true);
  }
  if (details.authenticationFailed === true || /auth|login|credential|password/i.test(message)) {
    return new NativeMailServiceError('AUTH_FAILED', '邮箱认证失败，请检查授权码', false);
  }
  return new NativeMailServiceError('CONNECTION_FAILED', '邮箱连接中断或服务器暂时不可用，请稍后重试', true);
}
