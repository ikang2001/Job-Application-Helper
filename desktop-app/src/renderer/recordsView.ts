import {
  APPLICATION_RECORD_STATUSES,
  compareApplicationRecordSubmissionTime,
  normalizeApplicationRecord,
} from '../../../src/shared/applicationRecords.ts';
import type { ApplicationRecord, ApplicationRecordStatus } from '../../../src/shared/types.ts';

export type RecordSort = 'recent' | 'oldest' | 'company' | 'status' | 'stage';
export type StatusFilter = ApplicationRecordStatus | '全部' | '已投递汇总';

export interface PipelineCount {
  status: ApplicationRecordStatus;
  filter: StatusFilter;
  count: number;
}

export interface CompanyRecordGroup {
  key: string;
  companyName: string;
  records: ApplicationRecord[];
}

export function pipelineCounts(records: readonly ApplicationRecord[]): PipelineCount[] {
  return APPLICATION_RECORD_STATUSES.map(status => ({
    status,
    filter: status === '已投递' ? '已投递汇总' : status,
    count: status === '已投递'
      ? records.filter(hasBeenSubmitted).length
      : records.filter(record => normalizeApplicationRecord(record).status === status).length,
  }));
}

export function filterAndSortRecords(
  recordsInput: readonly ApplicationRecord[],
  query: string,
  status: StatusFilter,
  sort: RecordSort,
): ApplicationRecord[] {
  const keyword = query.trim().toLocaleLowerCase();
  const records = recordsInput.map(normalizeApplicationRecord).filter((record) => {
    if (status === '已投递汇总' && !hasBeenSubmitted(record)) return false;
    if (status !== '全部' && status !== '已投递汇总' && record.status !== status) return false;
    if (!keyword) return true;
    return [
      record.companyName,
      record.jobTitle,
      record.location,
      record.sourceSite,
      record.notes,
      record.applicationEmail ?? '',
      ...scheduleSearchValues(record),
    ].some(value => value.toLocaleLowerCase().includes(keyword));
  });
  return records.sort((left, right) => compareRecords(left, right, sort));
}

function scheduleSearchValues(record: ApplicationRecord): string[] {
  const schedule = record.recruitmentSchedule;
  if (!schedule) return [];
  return [
    schedule.writtenTest,
    schedule.assessment,
    ...Object.values(schedule.interviews ?? {}),
  ]
    .flatMap(entry => entry ? [entry.scheduledAt, entry.url] : []);
}

function compareRecords(left: ApplicationRecord, right: ApplicationRecord, sort: RecordSort): number {
  if (sort === 'company') return left.companyName.localeCompare(right.companyName, 'zh-CN');
  if (sort === 'status') return left.status.localeCompare(right.status, 'zh-CN');
  if (sort === 'stage') {
    const stageDifference = applicationStageRank(left) - applicationStageRank(right);
    if (stageDifference !== 0) return stageDifference;
  }
  return compareApplicationRecordSubmissionTime(left, right, sort === 'oldest');
}

export function groupRecordsByCompany(recordsInput: readonly ApplicationRecord[]): CompanyRecordGroup[] {
  const groups = new Map<string, CompanyRecordGroup>();
  recordsInput.map(normalizeApplicationRecord).forEach((record) => {
    const companyName = record.companyName || '未填写公司';
    const key = companyName.replace(/\s+/g, '').toLocaleLowerCase();
    const group = groups.get(key) ?? { key, companyName, records: [] };
    group.records.push(record);
    groups.set(key, group);
  });
  return [...groups.values()].sort((left, right) => (
    right.records.length - left.records.length
    || left.companyName.localeCompare(right.companyName, 'zh-CN')
  ));
}

function hasBeenSubmitted(recordInput: ApplicationRecord): boolean {
  return normalizeApplicationRecord(recordInput).status !== '待投递';
}

function applicationStageRank(record: ApplicationRecord): number {
  if (record.status === 'offer') return 0;
  if (record.status === '面试中') return 1;
  if (record.status === '笔试/测评') {
    return hasScheduleEntry(record.recruitmentSchedule?.writtenTest) ? 2 : 3;
  }
  if (record.status === '等待中') return 4;
  if (record.status === '已投递') return 5;
  if (record.status === '待投递') return 6;
  return 7;
}

function hasScheduleEntry(entry: { scheduledAt: string; url: string } | undefined): boolean {
  return Boolean(entry?.scheduledAt || entry?.url);
}

export function activeApplicationCount(records: readonly ApplicationRecord[]): number {
  return records.filter(record => ['已投递', '等待中', '笔试/测评', '面试中'].includes(record.status)).length;
}
