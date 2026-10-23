import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { MailRuntime } from './mailRuntime.js';
import { NativeMailServiceError, normalizeImapError } from './mailErrors.js';
import { ImapMailService, type ImapClientPort } from './imapService.js';

const account = { id: 'test', provider: 'imap' as const, host: 'imap.example.com', port: 993,
  username: 'test@example.com', emailAddress: 'test@example.com', secure: true };

test('结构化 ALERT 优先识别为限流，不误报授权码失效', () => {
  const error = Object.assign(new Error('Command failed'), {
    authenticationFailed: true, serverResponseCode: 'ALERT',
    responseText: 'Too many login attempts, try again later',
  });
  assert.equal(normalizeImapError(error).code, 'RATE_LIMITED');
  assert.equal(normalizeImapError(Object.assign(new Error('Command failed'), { authenticationFailed: true })).code, 'AUTH_FAILED');
  assert.equal(normalizeImapError(Object.assign(new Error('Command failed'), { code: 'ETIMEDOUT' })).code, 'TIMEOUT');
});

test('冷却共享、30/60/120分钟、重启恢复、成功重置且不保存隐私', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jah-mail-runtime-'));
  let now = Date.parse('2026-10-23T00:00:00Z');
  try {
    for (const minutes of [30, 60, 120, 120]) {
      const runtime = new MailRuntime(directory, () => now);
      const lease = await runtime.acquire(account);
      const error = await lease.limited();
      assert.equal(Date.parse(error.retryAt!) - now, minutes * 60_000);
      await lease.release();
      await assert.rejects(new MailRuntime(directory, () => now).acquire({ ...account, id: 'other-client' }),
        (error: NativeMailServiceError) => error.code === 'RATE_LIMITED' && Boolean(error.retryAt));
      now += minutes * 60_000;
    }
    const lease = await new MailRuntime(directory, () => now).acquire(account);
    await lease.success();
    assert.equal(Date.parse((await lease.limited()).retryAt!) - now, 30 * 60_000);
    await lease.release();
    const contents = await readFile(join(directory, (await readdir(directory))[0]!), 'utf8');
    assert.doesNotMatch(contents, /example|secret|username|credential|subject/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('两端竞争同一邮箱返回忙，释放后可再次使用', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jah-mail-busy-'));
  const first = new MailRuntime(directory);
  try {
    const lease = await first.acquire(account);
    try {
      await assert.rejects(new MailRuntime(directory).acquire({ ...account, id: 'desktop' }),
        (error: NativeMailServiceError) => error.code === 'ACCOUNT_BUSY');
    } finally { await lease.release(); }
    await (await new MailRuntime(directory).acquire(account)).release();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('冷却期间连接/测试/扫描均不再登录，成功后恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jah-mail-no-login-'));
  let now = Date.parse('2026-10-23T00:00:00Z');
  let logins = 0;
  let limited = true;
  const factory = (): ImapClientPort => ({
    mailbox: false,
    connect: async () => { logins++; if (limited) throw Object.assign(new Error('Command failed'), { responseText: 'Too many login attempts, try again later' }); },
    logout: async () => undefined, getMailboxLock: async () => ({ release: () => undefined }),
    search: async () => [], fetchAll: async () => [], fetchOne: async () => false,
  });
  try {
    const service = new ImapMailService(factory, new MailRuntime(directory, () => now));
    await assert.rejects(service.testConnection(account, 'test-only'));
    await assert.rejects(service.beginSession(account, 'test-only'));
    await assert.rejects(service.testConnection(account, 'test-only'));
    await assert.rejects(new ImapMailService(factory, new MailRuntime(directory, () => now)).testConnection(account, 'test-only'));
    assert.equal(logins, 1);
    now += 30 * 60_000; limited = false;
    await service.testConnection(account, 'test-only'); assert.equal(logins, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('宿主异常退出后系统释放占用，不会留下永久死锁', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jah-mail-crash-'));
  const script = `import { MailRuntime } from './src/mailRuntime.ts';
    await new MailRuntime(process.env.TEST_MAIL_RUNTIME).acquire(${JSON.stringify(account)});
    process.send('ready'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    env: { ...process.env, TEST_MAIL_RUNTIME: directory }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  });
  try {
    await once(child, 'message');
    await assert.rejects(new MailRuntime(directory).acquire(account), (error: NativeMailServiceError) => error.code === 'ACCOUNT_BUSY');
    child.kill();
    await once(child, 'exit');
    await (await new MailRuntime(directory).acquire(account)).release();
  } finally { child.kill(); await rm(directory, { recursive: true, force: true }); }
});
