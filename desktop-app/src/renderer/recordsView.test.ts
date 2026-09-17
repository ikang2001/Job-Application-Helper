import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeApplicationRecord } from '../../../src/shared/applicationRecords.ts';
import type { ApplicationRecord, ApplicationRecordStatus, RecruitmentSchedule } from '../../../src/shared/types.ts';
import {
  activeApplicationCount,
  filterAndSortRecords,
  groupRecordsByCompany,
  pipelineCounts,
} from './recordsView.ts';

function record(
  id: string,
  status: ApplicationRecordStatus,
  companyName = '示例公司',
  recruitmentSchedule?: RecruitmentSchedule,
): ApplicationRecord {
  return normalizeApplicationRecord({
    id,
    companyName,
    jobTitle: `${id}工程师`,
    sourceSite: 'jobs.example.com',
    sourceUrl: `https://jobs.example.com/${id}`,
    status,
    notes: '',
    appliedAt: `2026-09-${String(10 - id.length).padStart(2, '0')}`,
    location: '北京',
    recruitmentSchedule,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  });
}

test('已投递汇总包含进入后续阶段的记录但不包含待投递', () => {
  const records = [
    record('pending', '待投递'),
    record('applied', '已投递'),
    record('waiting', '等待中'),
    record('assessment', '笔试/测评'),
    record('interview', '面试中'),
    record('offer', 'offer'),
    record('withdrawn', '主动放弃'),
  ];

  const submitted = filterAndSortRecords(records, '', '已投递汇总', 'recent');
  assert.deepEqual(submitted.map(item => item.id).sort(), [
    'applied', 'waiting', 'assessment', 'interview', 'offer', 'withdrawn',
  ].sort());
  assert.equal(pipelineCounts(records).find(item => item.status === '已投递')?.count, 6);
  assert.equal(pipelineCounts(records).find(item => item.status === '已投递')?.filter, '已投递汇总');
  assert.deepEqual(pipelineCounts(records).map(item => item.status), [
    '待投递', '已投递', '等待中', '笔试/测评', '面试中', 'offer', '主动放弃', '职位关闭', '终止',
  ]);
  assert.equal(activeApplicationCount(records), 4);
});

test('求职阶段排序将离录用最近的记录放在前面', () => {
  const records = [
    record('interview', '面试中'),
    record('written', '笔试/测评', '示例公司', {
      writtenTest: { scheduledAt: '2026-09-12T19:00', url: '' },
    }),
    record('offer', 'offer'),
    record('assessment', '笔试/测评', '示例公司', {
      assessment: { scheduledAt: '2026-09-11T19:00', url: '' },
    }),
    record('applied', '已投递'),
    record('waiting', '等待中'),
    record('pending', '待投递'),
    record('withdrawn', '主动放弃'),
  ];

  assert.deepEqual(
    filterAndSortRecords(records, '', '全部', 'stage').map(item => item.id),
    ['offer', 'interview', 'written', 'assessment', 'waiting', 'applied', 'pending', 'withdrawn'],
  );
});

test('同一天的最近和最早投递按实际创建时间排序', () => {
  const earlier = {
    ...record('earlier', '已投递'),
    appliedAt: '2026-09-09',
    createdAt: '2026-09-09T09:10:00.000Z',
  };
  const later = {
    ...record('later', '已投递'),
    appliedAt: '2026-09-09',
    createdAt: '2026-09-09T18:25:00.000Z',
  };

  assert.deepEqual(
    filterAndSortRecords([earlier, later], '', '已投递汇总', 'recent').map(item => item.id),
    ['later', 'earlier'],
  );
  assert.deepEqual(
    filterAndSortRecords([later, earlier], '', '已投递汇总', 'oldest').map(item => item.id),
    ['earlier', 'later'],
  );
});

test('按公司聚合同一公司的多个岗位并优先显示岗位数较多的公司', () => {
  const groups = groupRecordsByCompany([
    record('one', '已投递', '甲公司'),
    record('two', '面试中', '乙公司'),
    record('three', '笔试/测评', '甲 公司'),
  ]);

  assert.equal(groups[0]?.companyName, '甲公司');
  assert.deepEqual(groups[0]?.records.map(item => item.id), ['one', 'three']);
  assert.equal(groups[1]?.companyName, '乙公司');
});
