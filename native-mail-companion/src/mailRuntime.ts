import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import type { NativeMailAccountConfig } from './types.js';
import { NativeMailServiceError } from './mailErrors.js';

interface RuntimeState { failures: number; retryAt?: string; ownerPid?: number }
export interface MailLease {
  success(): Promise<void>;
  limited(): Promise<NativeMailServiceError>;
  release(): Promise<void>;
}

/** 独立运行状态，不读写投递数据和凭据。命名管道由系统在进程崩溃时释放。 */
export class MailRuntime {
  constructor(private readonly directory: string, private readonly now = () => Date.now()) {}

  async acquire(account: NativeMailAccountConfig): Promise<MailLease> {
    await mkdir(this.directory, { recursive: true });
    const key = createHash('sha256').update([
      account.host.toLowerCase(), account.port, account.username.trim().toLowerCase(),
    ].join('\0')).digest('hex');
    const path = join(this.directory, `${key}.json`);
    const readState = async (): Promise<RuntimeState> => {
      try {
        const value = JSON.parse(await readFile(path, 'utf8')) as RuntimeState;
        if (!Number.isInteger(value.failures) || value.failures < 0
          || (value.retryAt !== undefined && !Number.isFinite(Date.parse(value.retryAt)))) {
          throw new Error('invalid mail runtime state');
        }
        return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { failures: 0 };
        throw new NativeMailServiceError('CONNECTION_FAILED', '邮箱冷却状态文件不可读取，请稍后重试', true);
      }
    };
    const checkCooldown = (state: RuntimeState) => {
      if (state.retryAt && Date.parse(state.retryAt) > this.now()) throw cooldownError(state.retryAt);
    };
    checkCooldown(await readState());
    const namespace = createHash('sha256').update(this.directory.toLowerCase()).digest('hex').slice(0, 16);
    const server = await acquirePipe(`\\\\.\\pipe\\job-helper-mail-${namespace}-${key}`);
    let state: RuntimeState;
    try { state = await readState(); checkCooldown(state); }
    catch (error) { await closeServer(server); throw error; }
    const save = async () => {
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
    };
    state.ownerPid = process.pid;
    try { await save(); } catch (error) { await closeServer(server); throw error; }
    let released = false;
    return {
      success: async () => {
        if (state.failures === 0 && !state.retryAt) return;
        state = { failures: 0, ownerPid: process.pid };
        await save();
      },
      limited: async () => {
        const delay = [30, 60, 120][Math.min(state.failures, 2)]!;
        state.failures = Math.min(state.failures + 1, 3);
        state.retryAt = new Date(this.now() + delay * 60_000).toISOString();
        await save();
        return cooldownError(state.retryAt);
      },
      release: async () => {
        if (released) return;
        released = true;
        try { delete state.ownerPid; await save(); }
        finally { await closeServer(server); }
      },
    };
  }
}

function cooldownError(retryAt: string): NativeMailServiceError {
  const time = new Date(retryAt).toLocaleString('zh-CN', { hour12: false });
  return new NativeMailServiceError('RATE_LIMITED', `邮箱服务器限制登录频率，将于 ${time} 自动重试，无需重新授权`, true, retryAt);
}

function acquirePipe(path: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(socket => socket.destroy());
    server.once('error', () => reject(new NativeMailServiceError(
      'ACCOUNT_BUSY', '同一邮箱正在由桌面端或插件扫描，本次已跳过', true,
    )));
    server.listen({ path, exclusive: true }, () => resolve(server));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
