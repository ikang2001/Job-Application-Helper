import React, { useMemo, useState } from 'react';
import { MessageService } from '../shared/message.ts';
import type {
  ApplicationEvent,
  ApplicationRecord,
  InterviewRound,
  RecruitmentSchedule,
  RecruitmentScheduleEntry,
} from '../shared/types.ts';

type RecruitmentScheduleRow =
  | { group: 'stage'; kind: 'writtenTest' | 'assessment'; label: string }
  | { group: 'interview'; kind: InterviewRound; label: string };

const RECRUITMENT_STAGES: readonly RecruitmentScheduleRow[] = [
  { group: 'stage', kind: 'writtenTest', label: '笔试' },
  { group: 'stage', kind: 'assessment', label: '测评' },
  { group: 'interview', kind: 'ai', label: 'AI面' },
  { group: 'interview', kind: 'first', label: '一面' },
  { group: 'interview', kind: 'second', label: '二面' },
  { group: 'interview', kind: 'third', label: '三面' },
  { group: 'interview', kind: 'hr', label: 'HR面' },
];

interface ApplicationDetailProps {
  record: ApplicationRecord;
  onClose(): void;
  onChanged(): void | Promise<void>;
}

export function ApplicationDetail({ record, onClose, onChanged }: ApplicationDetailProps) {
  const [busySourceKey, setBusySourceKey] = useState('');
  const [error, setError] = useState('');
  const events = useMemo(() => [...record.events].sort((left, right) => (
    right.occurredAt.localeCompare(left.occurredAt) || right.sourceKey.localeCompare(left.sourceKey)
  )), [record.events]);

  const removeEvent = async (event: ApplicationEvent) => {
    if (typeof window !== 'undefined' && window.confirm && !window.confirm(`删除时间线事件“${event.title}”吗？`)) return;
    setBusySourceKey(event.sourceKey);
    setError('');
    const response = await MessageService.sendMessage({
      type: 'REMOVE_APPLICATION_EVENT',
      payload: { recordId: record.id, sourceKey: event.sourceKey, reason: 'deleted' },
    });
    if (!response.success) setError(response.error || '删除事件失败');
    else await onChanged();
    setBusySourceKey('');
  };

  return (
    <aside className="application-detail" role="dialog" aria-label="投递详情">
      <header className="application-detail-header">
        <div><p>APPLICATION</p><h3>{record.companyName || '未填写公司'}</h3><span>{record.jobTitle || '未填写岗位'}</span></div>
        <button type="button" onClick={onClose} aria-label="关闭投递详情">×</button>
      </header>
      {error && <div className="application-records-error" role="alert">{error}</div>}
      <dl className="application-detail-facts">
        <div><dt>当前状态</dt><dd><span className="application-detail-status">{record.status}</span></dd></div>
        <div><dt>Job ID</dt><dd>{record.jobId || '未记录'}</dd></div>
        <div><dt>Application ID</dt><dd>{record.applicationId || '未记录'}</dd></div>
        <div><dt>工作地点</dt><dd>{record.location || '未记录'}</dd></div>
        <div><dt>投递邮箱</dt><dd>{record.applicationEmail || '未记录'}</dd></div>
        <div><dt>使用简历</dt><dd>{record.resumeSnapshot?.profileName || record.resumeSnapshot?.fileName || '未记录'}</dd></div>
        <div><dt>投递日期</dt><dd>{record.appliedAt || '未记录'}</dd></div>
        <div><dt>来源页面</dt><dd>{record.sourceUrl ? <a href={record.sourceUrl} target="_blank" rel="noreferrer">打开原页面</a> : '未记录'}</dd></div>
      </dl>
      <section className="application-detail-section">
        <div className="application-detail-section-title"><h4>笔试、测评与面试安排</h4></div>
        <RecruitmentScheduleDetails record={record} />
      </section>
      <section className="application-detail-section">
        <div className="application-detail-section-title"><h4>岗位 JD 快照</h4>{record.jdSnapshot?.truncated && <span>已截断</span>}</div>
        <pre className="application-detail-jd">{record.jdSnapshot?.text || '尚未保存岗位描述'}</pre>
      </section>
      <section className="application-detail-section">
        <div className="application-detail-section-title"><h4>求职时间线</h4><span>{events.length} 个事件</span></div>
        {events.length === 0 ? <p className="application-detail-empty">暂无时间线事件</p> : (
          <ol className="application-timeline">
            {events.map(event => <li key={event.sourceKey} className={`source-${event.source}`}>
              <span className="application-timeline-dot" aria-hidden="true" />
              <div className="application-timeline-content">
                <div><strong>{event.title}</strong><time>{formatEventTime(event)}</time></div>
                <p>{event.note || event.metadata?.summary || sourceLabel(event.source)}</p>
                <small>{sourceLabel(event.source)}{event.decisionConfidence !== undefined ? ` · 置信度 ${Math.round(event.decisionConfidence * 100)}%` : ''}</small>
              </div>
              <button type="button" onClick={() => void removeEvent(event)} disabled={busySourceKey === event.sourceKey} aria-label={`删除事件 ${event.title}`}>删除</button>
            </li>)}
          </ol>
        )}
      </section>
    </aside>
  );
}

function RecruitmentScheduleDetails({ record }: { record: ApplicationRecord }) {
  const entries = RECRUITMENT_STAGES.map(stage => ({
    ...stage,
    entry: scheduleEntry(record.recruitmentSchedule, stage),
  })).filter(({ entry }) => entry?.scheduledAt || entry?.url);
  if (entries.length === 0) return <p className="application-detail-empty">尚未记录安排</p>;
  return (
    <div className="application-recruitment-schedule">
      {entries.map(({ kind, label, entry }) => entry && (
        <article key={kind}>
          <strong>{label}</strong>
          <time>{formatScheduleTime(entry.scheduledAt)}</time>
          {entry.url
            ? <a href={entry.url} target="_blank" rel="noreferrer">打开{label}链接</a>
            : <span>未填写链接</span>}
        </article>
      ))}
    </div>
  );
}

function scheduleEntry(
  schedule: RecruitmentSchedule | undefined,
  row: RecruitmentScheduleRow,
): RecruitmentScheduleEntry | undefined {
  return row.group === 'stage'
    ? schedule?.[row.kind]
    : schedule?.interviews?.[row.kind];
}

function formatScheduleTime(value: string): string {
  if (!value) return '时间待定';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('zh-CN', { hour12: false });
}

function formatEventTime(event: ApplicationEvent): string {
  if (event.timePrecision === 'date') return event.occurredAt.slice(0, 10);
  const date = new Date(event.occurredAt);
  return Number.isNaN(date.getTime()) ? event.occurredAt : date.toLocaleString('zh-CN', { hour12: false });
}

function sourceLabel(source: ApplicationEvent['source']): string {
  return ({ manual: '手动', website: '招聘网页', email: '招聘邮件', migration: '旧数据迁移' })[source];
}

export default ApplicationDetail;
