import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApplicationRecord } from '../../../src/shared/types.ts';
import { decideDesktopSyncAction, stableStringifyRecords } from './syncDecision.ts';

const baseInput = {
  localHash: 'local',
  remoteHash: 'remote',
  remoteExists: true,
  localCount: 1,
  hasSourceBackup: false,
};

test('首次启动且本地为空时自动接受远端记录', () => {
  assert.equal(decideDesktopSyncAction({ ...baseInput, localCount: 0 }), 'download-remote');
});

test('首次启动且两端都有不同记录时进入冲突', () => {
  assert.equal(decideDesktopSyncAction(baseInput), 'conflict');
});

test('只有本地记录变化时上传，只有远端记录变化时下载', () => {
  assert.equal(decideDesktopSyncAction({ ...baseInput, baseHash: 'remote' }), 'upload-local');
  assert.equal(decideDesktopSyncAction({ ...baseInput, baseHash: 'local' }), 'download-remote');
});

test('远端不存在时只有持有完整来源备份才允许创建', () => {
  assert.equal(decideDesktopSyncAction({ ...baseInput, remoteExists: false, remoteHash: undefined }), 'conflict');
  assert.equal(decideDesktopSyncAction({ ...baseInput, remoteExists: false, remoteHash: undefined, hasSourceBackup: true }), 'create-remote');
});

test('记录哈希序列化不受数组顺序影响', () => {
  const first = { id: 'a', companyName: '甲', events: [] } as unknown as ApplicationRecord;
  const second = { id: 'b', companyName: '乙', events: [] } as unknown as ApplicationRecord;
  assert.equal(stableStringifyRecords([first, second]), stableStringifyRecords([second, first]));
});
