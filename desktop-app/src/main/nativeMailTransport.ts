import type { ChildProcessWithoutNullStreams } from 'node:child_process';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 45_000;

export interface NativeResponse<T = unknown> {
  protocolVersion: 1;
  requestId: string;
  success: boolean;
  data?: T;
  error?: { code?: string; message?: string; retryable?: boolean; retryAt?: string };
}

export class DesktopMailError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly retryAt?: string,
  ) { super(message); }
}

/** 每帧独立限长，整轮下载正文可超过 1 MiB；请求按 requestId 配对。 */
export class NativeMailTransport {
  private buffer = Buffer.alloc(0);
  private closed = false;
  private readonly pending = new Map<string, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly timeoutMs = TIMEOUT_MS) {
    child.stdout.on('data', (chunk: Buffer) => {
      try { this.consume(chunk); }
      catch { this.fail(new DesktopMailError('INVALID_RESPONSE', '本地邮箱组件返回无效数据')); }
    });
    // 不将组件 stderr 原样带到 UI，避免意外泄漏账号或服务端响应。
    child.stderr.resume();
    child.once('error', () => this.fail(new DesktopMailError('SERVICE_UNAVAILABLE', '无法启动本地邮箱组件')));
    child.once('exit', () => this.fail(new DesktopMailError('CONNECTION_FAILED', '本地邮箱组件连接已关闭', true)));
    child.stdin.on('error', () => this.fail(new DesktopMailError('CONNECTION_FAILED', '无法写入本地邮箱组件', true)));
  }

  request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new DesktopMailError('CONNECTION_FAILED', '本地邮箱会话已关闭', true));
    const requestId = crypto.randomUUID();
    const bytes = Buffer.from(JSON.stringify({ protocolVersion: 1, requestId, type, ...payload }), 'utf8');
    const frame = Buffer.allocUnsafe(bytes.length + 4);
    frame.writeUInt32LE(bytes.length, 0);
    bytes.copy(frame, 4);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new DesktopMailError('TIMEOUT', '本地邮箱组件响应超时', true)), this.timeoutMs);
      this.pending.set(requestId, { resolve: value => resolve(value as T), reject, timer });
      this.child.stdin.write(frame);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(new DesktopMailError('CANCELLED', '本地邮箱会话已结束'));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 2_000);
    timer.unref();
    this.child.once('exit', () => clearTimeout(timer));
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length < 1 || length > MAX_RESPONSE_BYTES) throw new Error('invalid frame');
      if (this.buffer.length < length + 4) return;
      const response = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8')) as NativeResponse;
      this.buffer = this.buffer.subarray(length + 4);
      const pending = this.pending.get(response.requestId);
      if (!pending || response.protocolVersion !== 1) throw new Error('unmatched response');
      this.pending.delete(response.requestId);
      clearTimeout(pending.timer);
      if (response.success && response.data !== undefined) pending.resolve(response.data);
      else pending.reject(new DesktopMailError(response.error?.code || 'SERVICE_UNAVAILABLE',
        response.error?.message || '本地邮箱组件调用失败', response.error?.retryable, response.error?.retryAt));
    }
  }

  private fail(error: Error): void {
    this.rejectPending(error);
    this.close();
  }

  private rejectPending(error: Error): void {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
}
