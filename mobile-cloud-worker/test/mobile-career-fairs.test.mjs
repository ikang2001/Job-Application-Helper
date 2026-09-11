import assert from 'node:assert/strict';
import test from 'node:test';
import { filterAndSortCareerFairs } from '../../mobile-app/career-fairs.js';

test('手机端招聘会按开始时间从早到晚排列', () => {
  const fairs = [
    { name: '下周招聘会', startsAt: '2026-09-16T09:00' },
    { name: '已结束招聘会', startsAt: '2026-09-08T09:00', endsAt: '2026-09-08T17:00' },
    { name: '明天招聘会', startsAt: '2026-09-12T09:00' },
  ];

  assert.deepEqual(
    filterAndSortCareerFairs(fairs).map(fair => fair.name),
    ['已结束招聘会', '明天招聘会', '下周招聘会'],
  );
});

test('手机端筛选招聘会后仍按开始时间升序', () => {
  const fairs = [
    { name: '秋招双选会', location: '长安校区', startsAt: '2026-09-15T14:00' },
    { name: '综合招聘会', targetCompanies: '目标公司', startsAt: '2026-09-13T09:00' },
    { name: '秋招专场', notes: '目标公司展位', startsAt: '2026-09-14T10:00' },
  ];

  assert.deepEqual(
    filterAndSortCareerFairs(fairs, '目标公司').map(fair => fair.name),
    ['综合招聘会', '秋招专场'],
  );
});
