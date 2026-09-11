import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

const MAX_NATIVE_RESPONSE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const NATIVE_TIMEOUT_MS = 45_000;

export interface DesktopNativeMailAccount {
  id: string;
  provider: string;
  emailAddress: string;
  displayName?: string;
}

export interface DesktopNativeMailHeader {
  id: string;
  from: { name?: string; address: string };
  to: string[];
  subject: string;
  receivedAt: string;
}

export interface DesktopNativeMailMessage extends DesktopNativeMailHeader {
  accountId: string;
  text: string;
  truncated: boolean;
}

export interface DesktopNativeMailCursor {
  uidValidity: string;
  lastUid: number;
}

export interface DesktopNativeMailPage {
  messages: DesktopNativeMailHeader[];
  cursor: DesktopNativeMailCursor;
  hasMore: boolean;
}

export interface DesktopNativeMailPort {
  listAccounts(): Promise<DesktopNativeMailAccount[]>;
  ping(): Promise<{ host: string; version: string }>;
  testConnection(accountId: string): Promise<void>;
  listMessages(
    accountId: string,
    options: { since?: string; cursor?: DesktopNativeMailCursor; limit?: number },
  ): Promise<DesktopNativeMailPage>;
  getMessage(accountId: string, messageId: string): Promise<DesktopNativeMailMessage>;
}

interface NativeResponse<T> {
  protocolVersion: 1;
  requestId: string;
  success: boolean;
  data?: T;
  error?: { code?: string; message?: string; retryable?: boolean };
}

export class DesktopNativeMailClient implements DesktopNativeMailPort {
  constructor(
    private readonly localAppData = process.env.LOCALAPPDATA ?? '',
    private readonly spawnHost: (hostPath: string) => ChildProcessWithoutNullStreams = defaultSpawnHost,
  ) {}

  async listAccounts(): Promise<DesktopNativeMailAccount[]> {
    if (!this.localAppData) return [];
    const filePath = join(this.localAppData, 'JobApplicationHelper', 'mail-accounts.json');
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
      const accounts = (parsed as { accounts?: unknown }).accounts;
      if (!Array.isArray(accounts)) return [];
      return accounts.map(normalizeAccount).filter((item): item is DesktopNativeMailAccount => Boolean(item));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`读取本地邮箱账号失败：${error instanceof Error ? error.message : '文件无效'}`);
    }
  }

  async ping(): Promise<{ host: string; version: string }> {
    return this.request('PING', {});
  }

  async testConnection(accountId: string): Promise<void> {
    await this.request('TEST_CONNECTION', { accountId });
  }

  listMessages(
    accountId: string,
    options: { since?: string; cursor?: DesktopNativeMailCursor; limit?: number },
  ): Promise<DesktopNativeMailPage> {
    return this.request('LIST_MESSAGES', { accountId, ...options });
  }

  getMessage(accountId: string, messageId: string): Promise<DesktopNativeMailMessage> {
    return this.request('GET_MESSAGE', { accountId, messageId });
  }

  private async request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
    const hostPath = await this.hostPath();
    const requestId = crypto.randomUUID();
    const process = this.spawnHost(hostPath);
    const request = Buffer.from(JSON.stringify({
      protocolVersion: 1,
      requestId,
      type,
      ...payload,
    }), 'utf8');
    const frame = Buffer.allocUnsafe(request.length + 4);
    frame.writeUInt32LE(request.length, 0);
    request.copy(frame, 4);

    return new Promise<T>((resolve, reject) => {
      const output: Buffer[] = [];
      let outputLength = 0;
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        process.kill();
        finish(new Error('本地邮箱组件响应超时'));
      }, NATIVE_TIMEOUT_MS);

      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value as T);
      };

      process.stdout.on('data', (chunk: Buffer) => {
        outputLength += chunk.length;
        if (outputLength > MAX_NATIVE_RESPONSE_BYTES + 4) {
          process.kill();
          finish(new Error('本地邮箱组件响应过大'));
          return;
        }
        output.push(chunk);
        const combined = Buffer.concat(output, outputLength);
        if (combined.length < 4) return;
        const length = combined.readUInt32LE(0);
        if (length < 1 || length > MAX_NATIVE_RESPONSE_BYTES) {
          process.kill();
          finish(new Error('本地邮箱组件响应长度无效'));
          return;
        }
        if (combined.length < length + 4) return;
        try {
          const response = JSON.parse(combined.subarray(4, length + 4).toString('utf8')) as NativeResponse<T>;
          if (response.requestId !== requestId || response.protocolVersion !== 1) {
            throw new Error('本地邮箱组件响应与请求不匹配');
          }
          if (!response.success || response.data === undefined) {
            throw new Error(response.error?.message || '本地邮箱组件调用失败');
          }
          finish(undefined, response.data);
        } catch (error) {
          finish(error instanceof Error ? error : new Error('本地邮箱组件返回无效数据'));
        }
      });
      process.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString('utf8');
      });
      process.once('error', error => finish(new Error(`无法启动本地邮箱组件：${error.message}`)));
      process.once('exit', code => {
        if (!settled) finish(new Error(stderr.trim() || `本地邮箱组件异常退出（${code ?? 'unknown'}）`));
      });
      process.stdin.once('error', error => finish(new Error(`无法写入本地邮箱组件：${error.message}`)));
      process.stdin.end(frame);
    });
  }

  private async hostPath(): Promise<string> {
    if (!this.localAppData) throw new Error('未找到本地邮箱组件目录');
    const manifestPath = join(
      this.localAppData,
      'JobApplicationHelper',
      'NativeMessagingHosts',
      'com.job_application_helper.mail.json',
    );
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('本地邮箱组件未安装');
      throw new Error('本地邮箱组件清单无效');
    }
    const hostPath = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
      ? (manifest as { path?: unknown }).path
      : undefined;
    if (typeof hostPath !== 'string' || !hostPath.trim()) throw new Error('本地邮箱组件清单缺少启动路径');
    const extension = extname(hostPath).toLowerCase();
    if (!['.cmd', '.bat', '.exe'].includes(extension)) throw new Error('本地邮箱组件启动文件类型无效');
    try {
      if (!(await stat(hostPath)).isFile()) throw new Error('not a file');
    } catch {
      throw new Error('本地邮箱组件启动文件不存在，请重新安装组件');
    }
    return hostPath;
  }
}

function normalizeAccount(value: unknown): DesktopNativeMailAccount | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Partial<DesktopNativeMailAccount>;
  if (
    typeof input.id !== 'string'
    || typeof input.emailAddress !== 'string'
    || typeof input.provider !== 'string'
    || !input.id.trim()
    || !input.emailAddress.includes('@')
  ) return undefined;
  return {
    id: input.id.trim(),
    provider: input.provider.trim(),
    emailAddress: input.emailAddress.trim(),
    displayName: typeof input.displayName === 'string' ? input.displayName.trim() : undefined,
  };
}

function defaultSpawnHost(hostPath: string): ChildProcessWithoutNullStreams {
  const command = nativeHostSpawnCommand(hostPath);
  return spawn(command.executable, command.arguments, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function nativeHostSpawnCommand(
  hostPath: string,
  platform: NodeJS.Platform = process.platform,
  commandProcessor = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
): { executable: string; arguments: string[] } {
  if (platform === 'win32' && ['.cmd', '.bat'].includes(extname(hostPath).toLowerCase())) {
    return { executable: commandProcessor, arguments: ['/d', '/s', '/c', hostPath] };
  }
  return { executable: hostPath, arguments: [] };
}
