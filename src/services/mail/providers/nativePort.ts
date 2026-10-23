import { MailProviderError } from '../provider.ts';

export interface NativeResponse<T = unknown> {
  protocolVersion: 1;
  requestId: string;
  success: boolean;
  data?: T;
  error?: { code: string; message: string; retryable: boolean; retryAt?: string };
}

/** 一轮扫描一个端口；断线即失败，不自动重新登录。 */
export class NativePortClient {
  private closed = false;
  private readonly pending = new Map<string, {
    resolve(value: NativeResponse): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly port: chrome.runtime.Port) {
    port.onMessage.addListener((response: NativeResponse) => {
      const pending = this.pending.get(response.requestId);
      if (!pending || response.protocolVersion !== 1) { this.fail('本地邮箱组件响应与请求不匹配'); return; }
      clearTimeout(pending.timer);
      this.pending.delete(response.requestId);
      pending.resolve(response);
    });
    port.onDisconnect.addListener(() => {
      const unavailable = Boolean(chrome.runtime.lastError);
      this.fail(unavailable ? '本地邮箱组件不可用，请确认已安装 1.1.2 或更高版本' : '本地邮箱组件连接已关闭');
    });
  }

  send<T>(message: Record<string, unknown>): Promise<NativeResponse<T>> {
    if (this.closed) return Promise.reject(this.error('本地邮箱会话已关闭'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('本地邮箱组件响应超时', 'TIMEOUT'), 45_000);
      this.pending.set(String(message.requestId), { resolve: value => resolve(value as NativeResponse<T>), reject, timer });
      try { this.port.postMessage(message); }
      catch { this.fail('无法写入本地邮箱组件'); }
    });
  }

  close(): void {
    if (this.closed) return;
    this.fail('本地邮箱会话已结束');
  }

  private error(message: string, code: 'SERVICE_UNAVAILABLE' | 'TIMEOUT' = 'SERVICE_UNAVAILABLE'): MailProviderError {
    return new MailProviderError({ code, provider: 'imap', message, retryable: true });
  }

  private fail(message: string, code: 'SERVICE_UNAVAILABLE' | 'TIMEOUT' = 'SERVICE_UNAVAILABLE'): void {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(this.error(message, code)); }
    this.pending.clear();
    this.port.disconnect();
  }
}
