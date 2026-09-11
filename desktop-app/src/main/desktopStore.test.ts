import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DesktopStore, normalizeDesktopData } from './desktopStore.ts';

test('本地存储可连续写入并在主文件损坏时从备份恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'job-helper-desktop-store-'));
  try {
    const filePath = join(directory, 'desktop-data.json');
    const store = new DesktopStore(filePath);
    await store.write({ schemaVersion: 1, records: [], favoriteRecordIds: [], careerFairs: [], sync: { status: 'idle' } });
    await store.write({ schemaVersion: 1, records: [], favoriteRecordIds: [], careerFairs: [], sync: { status: 'disabled' } });
    await writeFile(filePath, '{broken', 'utf8');

    const recovered = await store.read();
    assert.equal(recovered.sync.status, 'idle');
    assert.doesNotReject(async () => JSON.parse(await readFile(filePath, 'utf8')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('旧桌面数据没有招聘会字段时兼容为空数组', () => {
  const normalized = normalizeDesktopData({ schemaVersion: 1, records: [], sync: { status: 'idle' } });
  assert.deepEqual(normalized.careerFairs, []);
  assert.equal(normalized.desktopReminder?.enabled, true);
  assert.equal(normalizeDesktopData({
    schemaVersion: 1,
    records: [],
    desktopReminder: { enabled: false },
    sync: { status: 'idle' },
  }).desktopReminder?.enabled, false);
});

test('旧桌面数据兼容空收藏，并清理重复或已不存在的收藏记录', () => {
  const oldData = normalizeDesktopData({ schemaVersion: 1, records: [], sync: { status: 'idle' } });
  assert.deepEqual(oldData.favoriteRecordIds, []);

  const normalized = normalizeDesktopData({
    schemaVersion: 1,
    records: [{
      id: 'record-1',
      companyName: '示例科技',
      jobTitle: '开发工程师',
      sourceSite: '',
      sourceUrl: '',
      status: '已投递',
      notes: '',
      appliedAt: '2026-09-09',
      location: '',
      createdAt: '2026-09-09T10:00:00.000Z',
      updatedAt: '2026-09-09T10:00:00.000Z',
      events: [],
    }],
    favoriteRecordIds: ['record-1', 'missing', 'record-1'],
    sync: { status: 'idle' },
  });
  assert.deepEqual(normalized.favoriteRecordIds, ['record-1']);
});
