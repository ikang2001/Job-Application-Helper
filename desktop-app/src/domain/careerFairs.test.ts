import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deleteCareerFair,
  filterAndSortCareerFairs,
  saveCareerFair,
  upcomingCareerFairCount,
  validateCareerFairInput,
} from './careerFairs.ts';

const NOW = '2026-09-09T08:00:00.000Z';

function input(name: string, startsAt: string) {
  return {
    name,
    status: '计划参加' as const,
    startsAt,
    endsAt: '',
    mode: '线下' as const,
    location: '会展中心一楼',
    organizer: '就业指导中心',
    registrationDeadline: '',
    eventUrl: 'https://career.example.com/fair',
    targetCompanies: '示例科技',
    targetRoles: 'Agent 开发工程师',
    preparation: '纸质简历 5 份',
    notes: '',
  };
}

test('招聘会可新建、更新和删除且保留创建时间', () => {
  const created = saveCareerFair([], input('秋季双选会', '2026-09-12T09:00'), NOW);
  const updated = saveCareerFair(created.careerFairs, {
    ...input('秋季双选会（中心校区）', '2026-09-12T09:00'),
    id: created.careerFair.id,
    status: '已报名',
  }, '2026-09-10T08:00:00.000Z');

  assert.equal(updated.careerFair.createdAt, NOW);
  assert.equal(updated.careerFair.status, '已报名');
  assert.equal(deleteCareerFair(updated.careerFairs, updated.careerFair.id).length, 0);
});

test('招聘会无论是否结束都按开始时间从早到晚排列', () => {
  const past = saveCareerFair([], input('昨天招聘会', '2026-09-08T09:00'), NOW).careerFair;
  const later = saveCareerFair([], input('下周招聘会', '2026-09-16T09:00'), NOW).careerFair;
  const soon = saveCareerFair([], input('明天招聘会', '2026-09-10T09:00'), NOW).careerFair;
  const skipped = saveCareerFair([], {
    ...input('不参加的招聘会', '2026-09-20T09:00'),
    status: '不参加',
  }, NOW).careerFair;
  const fairs = [past, later, skipped, soon];

  assert.deepEqual(
    filterAndSortCareerFairs(fairs, '').map(fair => fair.name),
    ['昨天招聘会', '明天招聘会', '下周招聘会', '不参加的招聘会'],
  );
  assert.equal(upcomingCareerFairCount(fairs, new Date(NOW)), 2);
  assert.equal(filterAndSortCareerFairs(fairs, '下周')[0]?.name, '下周招聘会');
});

test('招聘会校验拒绝结束早于开始和非 HTTP 链接', () => {
  assert.throws(() => validateCareerFairInput({
    ...input('错误时间', '2026-09-12T09:00'),
    endsAt: '2026-09-12T08:00',
  }), /结束时间不能早于开始时间/);
  assert.throws(() => validateCareerFairInput({
    ...input('错误链接', '2026-09-12T09:00'),
    eventUrl: 'file:///tmp/fair',
  }), /只支持 HTTP 或 HTTPS/);
});
