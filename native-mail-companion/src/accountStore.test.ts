import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonAccountStore } from './accountStore.js';
import type { NativeMailAccountConfig } from './types.js';

const account: NativeMailAccountConfig = {
  id: 'mail-1',
  provider: 'qq',
  emailAddress: 'user@qq.com',
  host: 'imap.qq.com',
  port: 993,
  secure: true,
  username: 'user@qq.com',
};

test('账号配置原子往返且不包含 credential', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jah-mail-store-'));
  const filePath = join(directory, 'accounts.json');
  try {
    const store = new JsonAccountStore(filePath);
    assert.equal(await store.get(account.id), null);
    await store.upsert(account);
    assert.deepEqual(await store.get(account.id), account);

    const raw = await readFile(filePath, 'utf8');
    assert.doesNotMatch(raw, /credential|password|授权码/i);

    await store.upsert({ ...account, displayName: '求职邮箱' });
    assert.equal((await store.get(account.id))?.displayName, '求职邮箱');
    await store.delete(account.id);
    assert.equal(await store.get(account.id), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
