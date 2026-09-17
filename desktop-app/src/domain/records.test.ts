import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackupDocument, serializeBackup } from '../../../src/shared/backup.ts';
import type { ApplicationRecord, BackupData, ResumeProfileLibrary, UserProfile } from '../../../src/shared/types.ts';
import {
  mergeDesktopCsv,
  parseDesktopRecordsJson,
  saveDesktopRecord,
  serializeDesktopData,
  serializeDesktopRecords,
  validateDesktopRecordInput,
} from './records.ts';
import { saveCareerFair } from './careerFairs.ts';
import { serializeApplicationRecordsCsv } from '../../../src/shared/applicationRecords.ts';

const NOW = '2026-09-04T08:00:00.000Z';

function input(overrides: Partial<Parameters<typeof saveDesktopRecord>[1]> = {}) {
  return {
    companyName: '示例科技',
    jobTitle: '前端工程师',
    sourceSite: 'jobs.example.com',
    sourceUrl: 'https://jobs.example.com/123',
    status: '已投递' as const,
    notes: '秋招岗位',
    appliedAt: '2026-09-04',
    location: '上海',
    ...overrides,
  };
}

function emptyProfile(): UserProfile {
  return {
    personal: {
      name: '', gender: '', birthDate: '', phone: '', email: '',
    },
    education: [],
    experience: [],
    projects: [],
    awards: [],
    customInformation: [],
    skills: [],
    certifications: [],
  };
}

function backupData(records: ApplicationRecord[]): BackupData {
  const library: ResumeProfileLibrary = {
    schemaVersion: 1,
    activeProfileId: 'default',
    profiles: [{ id: 'default', name: '默认简历', createdAt: NOW, updatedAt: NOW, profile: emptyProfile() }],
  };
  return { resumeProfileLibrary: library, llmConfig: null, settings: null, applicationRecords: records };
}

test('桌面端新建记录生成手动生命周期事件', () => {
  const saved = saveDesktopRecord([], input(), NOW);
  assert.equal(saved.records.length, 1);
  assert.equal(saved.record.status, '已投递');
  assert.equal(saved.record.events.length, 1);
  assert.equal(saved.record.events[0]?.source, 'manual');
  assert.equal(saved.record.events[0]?.type, 'applied');
});

test('桌面端可新建等待中记录并保存状态覆盖事件', () => {
  const saved = saveDesktopRecord([], input({ status: '等待中' }), NOW).record;
  assert.equal(saved.status, '等待中');
  assert.equal(saved.events[0]?.type, 'status_override');
  assert.equal(saved.events[0]?.metadata?.status, '等待中');
});

test('桌面端更新状态保留旧事件并新增人工覆盖事件', () => {
  const created = saveDesktopRecord([], input(), NOW).record;
  const updated = saveDesktopRecord(
    [created],
    input({ id: created.id, status: '面试中' }),
    '2026-09-05T08:00:00.000Z',
  ).record;
  assert.equal(updated.status, '面试中');
  assert.equal(updated.events.length, 2);
  assert.equal(updated.events.at(-1)?.type, 'status_override');
});

test('桌面端保存独立的笔试、测评和分轮面试时间与链接', () => {
  const recruitmentSchedule = {
    writtenTest: { scheduledAt: '2026-09-10T19:00', url: 'https://exam.example.com/written' },
    assessment: { scheduledAt: '2026-09-11T14:30', url: 'https://exam.example.com/assessment' },
    interviews: {
      ai: { scheduledAt: '2026-09-12T10:00', url: 'https://meeting.example.com/ai' },
      first: { scheduledAt: '2026-09-13T10:00', url: 'https://meeting.example.com/first' },
      second: { scheduledAt: '2026-09-14T10:00', url: 'https://meeting.example.com/second' },
      third: { scheduledAt: '2026-09-15T10:00', url: 'https://meeting.example.com/third' },
      hr: { scheduledAt: '2026-09-16T10:00', url: 'https://meeting.example.com/hr' },
    },
  };
  const saved = saveDesktopRecord([], input({ recruitmentSchedule }), NOW).record;

  assert.deepEqual(saved.recruitmentSchedule, recruitmentSchedule);
});

test('桌面端 JSON 导出可无损重新导入记录', () => {
  const record = saveDesktopRecord([], input(), NOW).record;
  const parsed = parseDesktopRecordsJson(serializeDesktopRecords([record], NOW));
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0]?.companyName, '示例科技');
  assert.equal(parsed.sourceBackup, undefined);
});

test('桌面端 JSON 备份包含招聘会且可无损重新导入', () => {
  const fair = saveCareerFair([], {
    name: '秋季双选会',
    status: '已报名',
    startsAt: '2026-09-12T09:00',
    endsAt: '2026-09-12T16:00',
    mode: '线下',
    location: '长安校区',
    organizer: '就业中心',
    registrationDeadline: '2026-09-11T18:00',
    eventUrl: 'https://career.example.com/fair',
    targetCompanies: '示例科技',
    targetRoles: 'Agent 开发工程师',
    preparation: '纸质简历',
    notes: 'A 区展位',
  }, NOW).careerFair;
  const parsed = parseDesktopRecordsJson(serializeDesktopData([], [fair], NOW));

  assert.deepEqual(parsed.careerFairs, [fair]);
});

test('桌面端可导入扩展 Backup V3 并保留完整来源文档', () => {
  const record = saveDesktopRecord([], input(), NOW).record;
  const document = createBackupDocument(backupData([record]), '1.0.0', NOW);
  const parsed = parseDesktopRecordsJson(serializeBackup(document));
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.sourceBackup?.data.resumeProfileLibrary.profiles[0]?.name, '默认简历');
});

test('CSV 合并跳过重复记录并保留现有数据', () => {
  const record = saveDesktopRecord([], input(), NOW).record;
  const merged = mergeDesktopCsv([record], serializeApplicationRecordsCsv([record]));
  assert.equal(merged.imported, 0);
  assert.equal(merged.records.length, 1);
  assert.equal(merged.warnings.length, 1);
});

test('桌面 IPC 记录校验拒绝非法状态和非 HTTP 链接', () => {
  assert.throws(
    () => validateDesktopRecordInput({ ...input(), status: '未知状态' }),
    /投递状态无效/,
  );
  assert.throws(
    () => validateDesktopRecordInput(input({ sourceUrl: 'file:///C:/secret.txt' })),
    /只支持 HTTP 或 HTTPS/,
  );
  assert.throws(
    () => validateDesktopRecordInput(input({
      recruitmentSchedule: {
        interviews: {
          first: { scheduledAt: '2026-09-12', url: 'https://meeting.example.com/interview' },
        },
      },
    })),
    /一面时间格式无效/,
  );
  assert.throws(
    () => validateDesktopRecordInput(input({
      recruitmentSchedule: {
        writtenTest: { scheduledAt: '2026-09-10T19:00', url: 'javascript:alert(1)' },
      },
    })),
    /笔试链接只支持 HTTP 或 HTTPS/,
  );
  assert.throws(
    () => validateDesktopRecordInput(input({
      recruitmentSchedule: {
        assessment: { scheduledAt: '2026-09-10T19:00', url: '', completedAt: '不是日期' },
      },
    })),
    /测评完成时间格式无效/,
  );
});
