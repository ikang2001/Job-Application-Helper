import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { DesktopMailError, NativeMailTransport } from './nativeMailTransport.ts';
export { DesktopMailError } from './nativeMailTransport.ts';

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
  ping(): Promise<{ host: string; version: string; capabilities?: string[] }>;
  beginScan?(accountId: string): Promise<void>;
  endScan?(accountId: string): Promise<void>;
  close?(): void;
  testConnection(accountId: string): Promise<void>;
  listMessages(
    accountId: string,
    options: { since?: string; cursor?: DesktopNativeMailCursor; limit?: number },
  ): Promise<DesktopNativeMailPage>;
  getMessage(accountId: string, messageId: string): Promise<DesktopNativeMailMessage>;
}

export class DesktopNativeMailClient implements DesktopNativeMailPort {
  private transport?: NativeMailTransport;
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

  async ping(): Promise<{ host: string; version: string; capabilities?: string[] }> {
    return this.request('PING', {});
  }

  async beginScan(accountId: string): Promise<void> {
    if (this.transport) throw new DesktopMailError('ACCOUNT_BUSY', '本地邮箱正在扫描，本次已跳过', true);
    const transport = new NativeMailTransport(this.spawnHost(await this.hostPath()));
    this.transport = transport;
    try {
      const ping = await transport.request<{ capabilities?: string[] }>('PING', {});
      if (!ping.capabilities?.includes('imap-session-v1')) {
        throw new DesktopMailError('UPGRADE_REQUIRED', '请先升级本地邮箱组件至 1.1.2 或更高版本（无需重新授权）');
      }
      await transport.request('BEGIN_SESSION', { accountId });
    } catch (error) { this.close(); throw error; }
  }

  async endScan(accountId: string): Promise<void> {
    try { await this.transport?.request('END_SESSION', { accountId }); }
    catch { this.close(); }
    finally { this.close(); }
  }

  close(): void { this.transport?.close(); this.transport = undefined; }

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
    if (this.transport) return this.transport.request<T>(type, payload);
    const transport = new NativeMailTransport(this.spawnHost(await this.hostPath()));
    try { return await transport.request<T>(type, payload); }
    finally { transport.close(); }
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
