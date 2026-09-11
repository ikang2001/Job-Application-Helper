import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPLICATION_RECORD_CSV_HEADERS,
  APPLICATION_RECORD_CSV_V2_HEADERS,
  createApplicationRecordDraft,
  findApplicationRecordDuplicate,
  findApplicationRecordDuplicateMatch,
  mergeApplicationRecordUpdate,
  normalizeApplicationRecord,
  normalizeApplicationRecordUrl,
  parseApplicationRecordsCsv,
  serializeApplicationRecordsCsv,
} from './applicationRecords.ts';
import { createApplicationEvent } from './applicationEvents.ts';
import { StorageService, STORAGE_KEYS } from './storage.ts';
import type { ApplicationRecord } from './types.ts';

function record(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  const applied = createApplicationEvent({
    type: 'applied',
    occurredAt: '2026-08-07',
    source: 'migration',
    title: '已投递',
    sourceKey: 'migration:r1:已投递',
  });
  return {
    id: 'r1',
    companyName: '字节跳动',
    jobTitle: '后端工程师',
    jobId: 'JOB-1',
    sourceSite: 'jobs.bytedance.com',
    sourceUrl: 'https://jobs.bytedance.com/example?jobId=JOB-1',
    status: '已投递',
    notes: '',
    appliedAt: '2026-08-07',
    location: '北京',
    events: [applied],
    createdAt: '2026-08-07T10:00:00.000Z',
    updatedAt: '2026-08-07T10:00:00.000Z',
    ...overrides,
  };
}

test('createApplicationRecordDraft 带岗位快照字段和确定性 applied 事件', () => {
  const draft = createApplicationRecordDraft('2026-08-07T10:00:00.000Z', {
    companyName: '字节跳动',
    jobTitle: '后端工程师',
    jobId: 'JOB-1',
    sourceSite: 'jobs.bytedance.com',
    sourceUrl: 'https://jobs.bytedance.com/example?utm_source=test&jobId=JOB-1',
    location: '北京',
    pageTitle: '字节跳动校园招聘',
  });
  assert.equal(draft.status, '已投递');
  assert.equal(draft.jobTitle, '后端工程师');
  assert.equal(draft.jobId, 'JOB-1');
  assert.equal(draft.events.length, 1);
  assert.equal(draft.events[0]?.type, 'applied');
  assert.equal(draft.events[0]?.sourceKey, 'website:https://jobs.bytedance.com/example?jobId=JOB-1:applied');
});

test('旧记录所有状态迁移为事件，保留未知字段且规范化幂等', () => {
  const cases = [
    ['待投', '待投递', 'application_created'],
    ['已投递', '已投递', 'applied'],
    ['已笔试', '笔试/测评', 'assessment_invite'],
    ['面试', '面试中', 'interview'],
    ['Offer', 'offer', 'offer'],
    ['拒绝', '已拒绝', 'rejection'],
    ['放弃', '主动放弃', 'withdrawn'],
    ['岗位关闭', '职位关闭', 'job_closed'],
    ['终止', '终止', 'status_override'],
  ] as const;

  for (const [legacyStatus, expectedStatus, eventType] of cases) {
    const normalized = normalizeApplicationRecord({
      id: `legacy-${legacyStatus}`,
      companyName: '示例公司',
      jobTitle: '工程师',
      sourceSite: 'example.com',
      sourceUrl: 'https://example.com/job/1',
      status: legacyStatus,
      notes: '',
      appliedAt: '2026-08-07',
      location: '',
      createdAt: '2026-08-07T10:00:00.000Z',
      updatedAt: '2026-08-07T10:00:00.000Z',
      customField: '必须保留',
    });
    assert.equal(normalized.status, expectedStatus);
    assert.equal(normalized.events[0]?.type, eventType);
    assert.equal(normalized.events[0]?.sourceKey, `migration:legacy-${legacyStatus}:${legacyStatus}`);
    assert.equal(normalized.events[0]?.occurredAt, '2026-08-07');
    assert.equal(normalized.events[0]?.timePrecision, 'date');
    assert.equal((normalized as ApplicationRecord & { customField: string }).customField, '必须保留');
    assert.deepEqual(normalizeApplicationRecord(normalized), normalized);
  }
});

test('非法旧状态保留迁移 warning 并使用安全默认状态', () => {
  const normalized = normalizeApplicationRecord({ id: 'bad-status', status: '未知状态' });
  assert.equal(normalized.status, '已投递');
  assert.match(normalized.migrationWarnings?.[0] ?? '', /未知状态/);
  assert.equal(normalized.events[0]?.sourceKey, 'migration:bad-status:未知状态');
  assert.deepEqual(normalizeApplicationRecord(normalized), normalized);
});

test('URL 规范化删除追踪参数/无意义 hash，但保留岗位标识', () => {
  assert.equal(
    normalizeApplicationRecordUrl(
      'HTTPS://Jobs.Example.com:443/position/1/?utm_source=x&session=abc&reqId=R1&jobId=J1#details',
    ),
    'https://jobs.example.com/position/1?jobId=J1&reqId=R1',
  );
  assert.equal(
    normalizeApplicationRecordUrl('https://jobs.example.com/#/position/jobId=J1'),
    'https://jobs.example.com/#/position/jobId=J1',
  );
});

test('重复判断依次使用公司+jobId、规范 URL、公司+岗位+地点', () => {
  const records = [
    record({ id: 'by-url', companyName: '甲', jobId: 'other' }),
    record({ id: 'by-job-id', companyName: '字节跳动', jobId: 'JOB-1', sourceUrl: 'https://other.example/1' }),
  ];
  assert.deepEqual(
    findApplicationRecordDuplicateMatch(records, {
      companyName: ' 字节跳动 ',
      jobId: 'job-1',
      sourceUrl: records[0]!.sourceUrl,
    }),
    { record: records[1], kind: 'company_job_id' },
  );
  assert.equal(findApplicationRecordDuplicate(records, {
    companyName: '其他公司',
    sourceUrl: `${records[0]!.sourceUrl}&utm_campaign=summer#apply`,
  })?.id, 'by-url');
  assert.equal(findApplicationRecordDuplicate([
    record({ id: 'weak', sourceUrl: '', jobId: undefined }),
  ], {
    companyName: '字节跳动',
    jobTitle: '后端工程师',
    location: '北京',
    sourceUrl: '',
  })?.id, 'weak');
});

test('旧平面状态编辑转为人工覆盖，并合并编辑期间新增事件', () => {
  const current = record({
    events: [
      ...record().events,
      createApplicationEvent({
        type: 'assessment_invite',
        occurredAt: '2026-08-08T00:00:00.000Z',
        source: 'email',
        title: '测评邀请',
        sourceKey: 'email:gmail:a:m1:assessment_invite',
      }),
    ],
    status: '笔试/测评',
  });
  const staleForm = {
    ...record(),
    status: '面试中' as const,
    notes: '一面通过',
    updatedAt: '2026-08-09T00:00:00.000Z',
  };
  const merged = mergeApplicationRecordUpdate(current, staleForm);
  assert.equal(merged.status, '面试中');
  assert.equal(merged.notes, '一面通过');
  assert.equal(merged.events.some(event => event.sourceKey.includes(':m1:')), true);
  assert.equal(merged.events.filter(event => event.type === 'status_override').length, 1);
});

test('规范化保留笔试、测评和分轮面试安排并清除空项目', () => {
  const normalized = normalizeApplicationRecord(record({
    recruitmentSchedule: {
      writtenTest: { scheduledAt: ' 2026-09-10T19:00 ', url: ' https://exam.example.com/written ' },
      assessment: { scheduledAt: '2026-09-11T14:30', url: '', timeKind: 'deadline', completedAt: '2026-09-10T16:00:00.000Z' },
      interviews: {
        ai: { scheduledAt: '2026-09-12T10:00', url: 'https://meeting.example.com/ai' },
        first: { scheduledAt: '2026-09-13T10:00', url: 'https://meeting.example.com/first', timeKind: 'start' },
        hr: { scheduledAt: '', url: '' },
      },
    },
  }));

  assert.deepEqual(normalized.recruitmentSchedule, {
    writtenTest: { scheduledAt: '2026-09-10T19:00', url: 'https://exam.example.com/written' },
    assessment: { scheduledAt: '2026-09-11T14:30', url: '', timeKind: 'deadline', completedAt: '2026-09-10T16:00:00.000Z' },
    interviews: {
      ai: { scheduledAt: '2026-09-12T10:00', url: 'https://meeting.example.com/ai' },
      first: { scheduledAt: '2026-09-13T10:00', url: 'https://meeting.example.com/first', timeKind: 'start' },
    },
  });
});

test('旧版单面试安排无损迁移为一面', () => {
  const normalized = normalizeApplicationRecord({
    ...record(),
    recruitmentSchedule: {
      interview: { scheduledAt: '2026-09-12T10:00', url: 'https://meeting.example.com/legacy' },
    },
  });

  assert.deepEqual(normalized.recruitmentSchedule, {
    interviews: {
      first: { scheduledAt: '2026-09-12T10:00', url: 'https://meeting.example.com/legacy' },
    },
  });
});

test('CSV 固定保留 V1，默认导出显式 V2 + BOM/CRLF 并往返摘要字段', () => {
  assert.deepEqual(APPLICATION_RECORD_CSV_HEADERS, [
    'companyName', 'jobTitle', 'sourceSite', 'sourceUrl', 'status',
    'notes', 'appliedAt', 'location', 'createdAt', 'updatedAt',
  ]);
  assert.equal(APPLICATION_RECORD_CSV_V2_HEADERS[0], 'schemaVersion');

  const input = record({
    applicationId: 'APP-1',
    applicationEmail: 'candidate@example.com',
    notes: '包含,逗号\n和换行',
    resumeSnapshot: { profileName: '中文简历', fileName: 'resume.pdf' },
    recruitmentSchedule: {
      writtenTest: { scheduledAt: '2026-09-10T19:00', url: 'https://exam.example.com/written' },
      assessment: { scheduledAt: '2026-09-11T14:30', url: 'https://exam.example.com/assessment' },
      interviews: {
        ai: { scheduledAt: '2026-09-12T10:00', url: 'https://meeting.example.com/ai' },
        first: { scheduledAt: '2026-09-13T10:00', url: 'https://meeting.example.com/first' },
        second: { scheduledAt: '2026-09-14T10:00', url: 'https://meeting.example.com/second' },
        third: { scheduledAt: '2026-09-15T10:00', url: 'https://meeting.example.com/third' },
        hr: { scheduledAt: '2026-09-16T10:00', url: 'https://meeting.example.com/hr' },
      },
    },
  });
  const csv = serializeApplicationRecordsCsv([input]);
  assert.equal(csv.startsWith('\uFEFFschemaVersion,id,'), true);
  assert.match(csv, /\r\n/);
  const parsed = parseApplicationRecordsCsv(csv);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.records[0]?.id, 'r1');
  assert.equal(parsed.records[0]?.applicationId, 'APP-1');
  assert.equal(parsed.records[0]?.applicationEmail, 'candidate@example.com');
  assert.equal(parsed.records[0]?.resumeSnapshot?.profileName, '中文简历');
  assert.equal(parsed.records[0]?.notes, '包含,逗号\n和换行');
  assert.deepEqual(parsed.records[0]?.recruitmentSchedule, input.recruitmentSchedule);
  assert.equal(parsed.records[0]?.events.length, 1);

  const legacyCsv = serializeApplicationRecordsCsv([input], 1);
  assert.equal(parseApplicationRecordsCsv(legacyCsv).version, 1);
});

test('旧版 V2 CSV 的单面试列继续导入为一面', () => {
  const headers = [
    'schemaVersion', 'id', 'companyName', 'jobTitle', 'jobId', 'applicationId',
    'sourceSite', 'sourceUrl', 'status', 'notes', 'appliedAt', 'location',
    'employmentType', 'applicationEmail', 'writtenTestAt', 'writtenTestUrl',
    'assessmentAt', 'assessmentUrl', 'interviewAt', 'interviewUrl',
    'resumeProfileName', 'resumeFileName', 'createdAt', 'updatedAt',
  ];
  const values = [
    '2', 'legacy-v2', '示例公司', '工程师', '', '', 'example.com',
    'https://example.com/job/1', '面试中', '', '2026-09-01', '北京', '', '',
    '', '', '', '', '2026-09-12T10:00', 'https://meeting.example.com/legacy',
    '', '', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
  ];
  const parsed = parseApplicationRecordsCsv(`${headers.join(',')}\n${values.join(',')}`);

  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.records[0]?.recruitmentSchedule?.interviews?.first, {
    scheduledAt: '2026-09-12T10:00',
    url: 'https://meeting.example.com/legacy',
  });
});

test('CSV V1 继续导入旧状态，非法表头和非法状态返回清晰诊断', () => {
  const csv = [
    APPLICATION_RECORD_CSV_HEADERS.join(','),
    '腾讯,后台开发,tencent.com,https://careers.tencent.com/1,已笔试,,2026-08-09,深圳,2026-08-09T10:00:00.000Z,2026-08-09T10:00:00.000Z',
  ].join('\n');
  const parsed = parseApplicationRecordsCsv(csv);
  assert.equal(parsed.records[0]?.status, '笔试/测评');
  assert.equal(parsed.records[0]?.events[0]?.type, 'assessment_invite');

  assert.match(parseApplicationRecordsCsv('companyName,status\na,b').error ?? '', /V1 或 V2/);
  const invalidStatus = parseApplicationRecordsCsv([
    APPLICATION_RECORD_CSV_HEADERS.join(','),
    '腾讯,后台开发,tencent.com,https://careers.tencent.com/1,未知,,2026-08-09,深圳,a,b',
  ].join('\n'));
  assert.equal(invalidStatus.records.length, 0);
  assert.match(invalidStatus.warnings[0] ?? '', /非法状态/);
});

test('StorageService 读取旧记录时返回 canonical V2 且保存后不丢事件', async () => {
  const storageState: Record<string, unknown> = {
    [STORAGE_KEYS.APPLICATION_RECORDS]: [{
      id: 'legacy-r1',
      companyName: '字节跳动',
      jobTitle: '',
      sourceSite: 'jobs.bytedance.com',
      sourceUrl: 'https://jobs.bytedance.com/example',
      status: 'Offer',
      notes: '',
      appliedAt: '2026-08-07',
      location: '',
      createdAt: '2026-08-07T10:00:00.000Z',
      updatedAt: '2026-08-07T10:00:00.000Z',
    }],
  };
  const originalChrome = (globalThis as { chrome?: unknown }).chrome;
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: storageState[key] }),
        set: async (values: Record<string, unknown>) => Object.assign(storageState, values),
      },
    },
  };

  try {
    const records = await StorageService.getApplicationRecords();
    assert.equal(records[0]?.status, 'offer');
    assert.equal(records[0]?.events.length, 1);
    await StorageService.saveApplicationRecords(records);
    assert.deepEqual(await StorageService.getApplicationRecords(), records);
  } finally {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
  }
});
