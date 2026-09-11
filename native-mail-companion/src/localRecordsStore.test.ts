import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalApplicationRecordsStore } from './localRecordsStore.js';

function record(id: string, updatedAt: string, companyName: string) {
  return { id, updatedAt, companyName };
}

test('桌面端与 Edge 按更新时间合并同一记录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jah-local-records-'));
  try {
    const store = new LocalApplicationRecordsStore(join(directory, 'records.json'));
    await store.merge({
      writer: 'edge',
      records: [record('one', '2026-09-04T01:00:00.000Z', '旧名称')],
    });
    const merged = await store.merge({
      writer: 'desktop',
      records: [
        record('one', '2026-09-04T02:00:00.000Z', '新名称'),
        record('two', '2026-09-04T01:30:00.000Z', '另一家公司'),
      ],
    });
    assert.deepEqual(merged.records.map(item => item.companyName), ['新名称', '另一家公司']);
    assert.equal(merged.revision, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('删除标记阻止旧快照恢复，并允许更新后的记录重新出现', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jah-local-records-'));
  try {
    const store = new LocalApplicationRecordsStore(join(directory, 'records.json'));
    await store.merge({
      writer: 'edge',
      records: [record('one', '2026-09-04T01:00:00.000Z', '旧记录')],
    });
    await store.merge({
      writer: 'desktop',
      records: [],
      tombstones: [{ id: 'one', deletedAt: '2026-09-04T02:00:00.000Z' }],
    });
    const stale = await store.merge({
      writer: 'edge',
      records: [record('one', '2026-09-04T01:00:00.000Z', '旧记录')],
    });
    assert.equal(stale.records.length, 0);

    const revived = await store.merge({
      writer: 'edge',
      records: [record('one', '2026-09-04T03:00:00.000Z', '主动恢复')],
    });
    assert.equal(revived.records[0]?.companyName, '主动恢复');
    assert.equal(revived.tombstones.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('分块读取可重组并校验 revision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jah-local-records-'));
  try {
    const filePath = join(directory, 'records.json');
    const store = new LocalApplicationRecordsStore(filePath);
    await store.merge({
      writer: 'edge',
      records: [record('large', '2026-09-04T01:00:00.000Z', '测'.repeat(200_000))],
    });
    const meta = await store.getMeta();
    const chunks = await Promise.all(Array.from({ length: meta.chunkCount }, (_, index) => (
      store.readChunk(meta.revision, index)
    )));
    const restored = Buffer.concat(chunks.map(chunk => Buffer.from(chunk.base64, 'base64'))).toString('utf8');
    assert.deepEqual(JSON.parse(restored), JSON.parse(await readFile(filePath, 'utf8')));
    await assert.rejects(() => store.readChunk(meta.revision + 1, 0), /重新读取元数据/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('旧记录缺少更新时间时使用稳定回退值而不是阻断同步', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jah-local-records-'));
  try {
    const store = new LocalApplicationRecordsStore(join(directory, 'records.json'));
    const merged = await store.merge({
      writer: 'edge',
      records: [{ id: 'legacy', updatedAt: '', companyName: '旧数据' }],
    });
    assert.equal(merged.records[0]?.updatedAt, '1970-01-01T00:00:00.000Z');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
