import React, { useState } from 'react';
import { APPLICATION_RECORD_STATUSES } from '../../../src/shared/applicationRecords.ts';
import type {
  ApplicationEvent,
  ApplicationRecord,
  ApplicationRecordStatus,
  RecruitmentScheduleEntry,
} from '../../../src/shared/types.ts';
import type { DesktopRecordInput } from '../shared/contracts.ts';
import { desktopRecordInput } from '../domain/records.ts';
import { CloseIcon, ExternalIcon } from './Icons.tsx';
import {
  clearScheduleEntry,
  formatScheduleTime,
  RECRUITMENT_SCHEDULE_ROWS,
  scheduleEntry,
  scheduleDisplayLabel,
  type RecruitmentScheduleRow,
  updateScheduleEntry,
} from './recruitmentSchedule.ts';

type RecordPanelMode = 'view' | 'edit' | 'new';

interface RecordPanelProps {
  mode: RecordPanelMode;
  record?: ApplicationRecord;
  busy: boolean;
  onClose(): void;
  onEdit(): void;
  onDelete(record: ApplicationRecord): void;
  onOpenUrl(url: string): void;
  onSave(input: DesktopRecordInput): void;
}

export function RecordPanel(props: RecordPanelProps) {
  const [form, setForm] = useState<DesktopRecordInput>(() => (
    props.record ? desktopRecordInput(props.record) : emptyRecordInput()
  ));
  const isForm = props.mode !== 'view';
  return (
    <div className="panel-backdrop" onMouseDown={event => event.target === event.currentTarget && props.onClose()}>
      <aside className="record-panel" role="dialog" aria-modal="true" aria-label={panelTitle(props.mode)}>
        <header className="panel-header">
          <div><p>{isForm ? 'RECORD EDITOR' : 'APPLICATION FILE'}</p><h2>{panelTitle(props.mode)}</h2></div>
          <button type="button" className="square-button" onClick={props.onClose} aria-label="关闭"><CloseIcon /></button>
        </header>
        {isForm ? (
          <RecordForm form={form} busy={props.busy} onChange={setForm} onSave={props.onSave} onCancel={props.onClose} />
        ) : props.record ? (
          <RecordDetails {...props} record={props.record} />
        ) : null}
      </aside>
    </div>
  );
}

function RecordForm({
  form,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  form: DesktopRecordInput;
  busy: boolean;
  onChange(value: DesktopRecordInput): void;
  onSave(value: DesktopRecordInput): void;
  onCancel(): void;
}) {
  const update = <K extends keyof DesktopRecordInput>(key: K, value: DesktopRecordInput[K]) => {
    onChange({ ...form, [key]: value });
  };
  const updateSchedule = (
    row: RecruitmentScheduleRow,
    field: keyof RecruitmentScheduleEntry,
    value: RecruitmentScheduleEntry[keyof RecruitmentScheduleEntry],
  ) => {
    onChange({
      ...form,
      recruitmentSchedule: updateScheduleEntry(form.recruitmentSchedule, row, field, value),
    });
  };
  const clearSchedule = (row: RecruitmentScheduleRow) => {
    onChange({
      ...form,
      recruitmentSchedule: clearScheduleEntry(form.recruitmentSchedule, row),
    });
  };
  return (
    <form className="record-form" onSubmit={(event) => { event.preventDefault(); onSave(form); }}>
      <div className="form-grid">
        <label><span>公司名称</span><input required value={form.companyName} onChange={event => update('companyName', event.target.value)} /></label>
        <label><span>岗位名称</span><input required value={form.jobTitle} onChange={event => update('jobTitle', event.target.value)} /></label>
        <label><span>当前状态</span><select value={form.status} onChange={event => update('status', event.target.value as ApplicationRecordStatus)}>{APPLICATION_RECORD_STATUSES.map(status => <option key={status}>{status}</option>)}</select></label>
        <label><span>投递日期</span><input type="date" value={form.appliedAt} onChange={event => update('appliedAt', event.target.value)} /></label>
        <fieldset className="schedule-editor form-span-two">
          <legend>笔试、测评与面试安排</legend>
          <p>每一项都可单独记录准确时间和链接；没有安排的项目可以留空。</p>
          <div>
            {RECRUITMENT_SCHEDULE_ROWS.map((row) => {
              const { kind, label } = row;
              const entry = scheduleEntry(form.recruitmentSchedule, row);
              return (
                <React.Fragment key={kind}>
                  <div className="schedule-time-field">
                    <div>
                      <label htmlFor={`schedule-${kind}-time`}>{label}时间</label>
                      <button
                        type="button"
                        className="schedule-clear-button"
                        disabled={!entry.scheduledAt && !entry.url && !entry.timeKind && !entry.completedAt}
                        aria-label={`清空${label}安排`}
                        onClick={() => clearSchedule(row)}
                      >
                        清空
                      </button>
                    </div>
                    <input
                      id={`schedule-${kind}-time`}
                      type="datetime-local"
                      value={entry.scheduledAt}
                      aria-label={`${label}时间`}
                      onChange={event => updateSchedule(row, 'scheduledAt', event.target.value)}
                    />
                  </div>
                  <label>
                    <span>{label}时间含义</span>
                    <select
                      value={entry.timeKind ?? ''}
                      aria-label={`${label}时间含义`}
                      onChange={(event) => {
                        const value = event.target.value;
                        updateSchedule(
                          row,
                          'timeKind',
                          value === '' ? undefined : value as RecruitmentScheduleEntry['timeKind'],
                        );
                      }}
                    >
                      <option value="">未注明</option>
                      <option value="start">开始时间</option>
                      <option value="deadline">截止时间</option>
                    </select>
                  </label>
                  <label>
                    <span>{label}链接</span>
                    <input
                      type="url"
                      value={entry.url}
                      aria-label={`${label}链接`}
                      placeholder="https://"
                      onChange={event => updateSchedule(row, 'url', event.target.value)}
                    />
                  </label>
                </React.Fragment>
              );
            })}
          </div>
        </fieldset>
        <label><span>工作地点</span><input value={form.location} onChange={event => update('location', event.target.value)} /></label>
        <label><span>来源站点</span><input value={form.sourceSite} onChange={event => update('sourceSite', event.target.value)} placeholder="如 campus.example.com" /></label>
        <label className="form-span-two"><span>职位链接</span><input type="url" value={form.sourceUrl} onChange={event => update('sourceUrl', event.target.value)} placeholder="https://" /></label>
        <label><span>投递邮箱</span><input type="email" value={form.applicationEmail ?? ''} onChange={event => update('applicationEmail', event.target.value)} /></label>
        <label><span>用工类型</span><input value={form.employmentType ?? ''} onChange={event => update('employmentType', event.target.value)} placeholder="校招 / 实习" /></label>
        <label><span>Job ID</span><input value={form.jobId ?? ''} onChange={event => update('jobId', event.target.value)} /></label>
        <label><span>Application ID</span><input value={form.applicationId ?? ''} onChange={event => update('applicationId', event.target.value)} /></label>
        <label className="form-span-two"><span>备注</span><textarea rows={5} value={form.notes} onChange={event => update('notes', event.target.value)} placeholder="记录内推人、下一步安排或需要跟进的事项" /></label>
      </div>
      <footer className="panel-actions">
        <button type="button" className="button-secondary" onClick={onCancel} disabled={busy}>取消</button>
        <button type="submit" className="button-primary" disabled={busy}>{busy ? '保存中…' : '保存记录'}</button>
      </footer>
    </form>
  );
}

function RecordDetails(props: RecordPanelProps & { record: ApplicationRecord }) {
  const { record } = props;
  const events = [...record.events].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
  return (
    <div className="record-details">
      <div className="detail-identity">
        <span className="detail-status">{record.status}</span>
        <h3>{record.companyName || '未填写公司'}</h3>
        <p>{record.jobTitle || '未填写岗位'}</p>
        {record.sourceUrl && <button type="button" onClick={() => props.onOpenUrl(record.sourceUrl)}>打开职位页面 <ExternalIcon /></button>}
      </div>
      <dl className="detail-facts">
        <Fact label="投递日期" value={record.appliedAt} />
        <Fact label="工作地点" value={record.location} />
        <Fact label="来源站点" value={record.sourceSite} />
        <Fact label="投递邮箱" value={record.applicationEmail} />
        <Fact label="Job ID" value={record.jobId} />
        <Fact label="Application ID" value={record.applicationId} />
        <Fact label="使用简历" value={record.resumeSnapshot?.profileName || record.resumeSnapshot?.fileName} />
        <Fact label="最近更新" value={formatTime(record.updatedAt)} />
      </dl>
      <DetailSection title="笔试、测评与面试安排">
        <ScheduleDetails record={record} onOpenUrl={props.onOpenUrl} />
      </DetailSection>
      <DetailSection title="备注">
        <NotesContent notes={record.notes} onOpenUrl={props.onOpenUrl} />
      </DetailSection>
      <DetailSection title="岗位 JD 快照" meta={record.jdSnapshot?.truncated ? '已截断' : undefined}>
        <pre className="detail-jd">{record.jdSnapshot?.text || '尚未保存岗位描述'}</pre>
      </DetailSection>
      <DetailSection title="求职时间线" meta={`${events.length} 个事件`}>
        {events.length === 0 ? <p className="detail-copy">暂无时间线事件</p> : <EventTimeline events={events} />}
      </DetailSection>
      <footer className="panel-actions sticky-actions">
        <button type="button" className="button-danger" onClick={() => props.onDelete(record)} disabled={props.busy}>删除</button>
        <button type="button" className="button-primary" onClick={props.onEdit} disabled={props.busy}>编辑记录</button>
      </footer>
    </div>
  );
}

function ScheduleDetails({ record, onOpenUrl }: { record: ApplicationRecord; onOpenUrl(url: string): void }) {
  const entries = RECRUITMENT_SCHEDULE_ROWS.map(row => ({
    ...row,
    entry: scheduleEntry(record.recruitmentSchedule, row),
  })).filter(({ entry }) => entry.scheduledAt || entry.url);
  if (entries.length === 0) return <p className="detail-copy">尚未记录笔试、测评或面试安排</p>;
  return (
    <div className="schedule-details">
      {entries.map(({ kind, label, entry }) => (
        <article key={kind} className={`schedule-card${entry.completedAt ? ' is-completed' : ''}`}>
          <strong>{scheduleDisplayLabel(label, entry)}</strong>
          <span>{formatScheduleTime(entry.scheduledAt)}</span>
          {entry.url ? (
            <button type="button" onClick={() => onOpenUrl(entry.url)}>
              打开{label}链接 <ExternalIcon />
            </button>
          ) : <small>未填写链接</small>}
        </article>
      ))}
    </div>
  );
}

function Fact({ label, value }: { label: string; value?: string }) {
  return <div><dt>{label}</dt><dd>{value || '未记录'}</dd></div>;
}

function DetailSection({ title, meta, children }: React.PropsWithChildren<{ title: string; meta?: string }>) {
  return <section className="detail-section"><header><h4>{title}</h4>{meta && <span>{meta}</span>}</header>{children}</section>;
}

function EventTimeline({ events }: { events: ApplicationEvent[] }) {
  return (
    <ol className="event-timeline">
      {events.map(event => (
        <li key={event.sourceKey}>
          <span className={`event-dot source-${event.source}`} />
          <div><strong>{event.title}</strong><time>{formatEventTime(event)}</time><p>{event.note || event.metadata?.summary || sourceLabel(event.source)}</p></div>
        </li>
      ))}
    </ol>
  );
}

function emptyRecordInput(): DesktopRecordInput {
  return {
    companyName: '',
    jobTitle: '',
    sourceSite: '',
    sourceUrl: '',
    status: '待投递',
    notes: '',
    appliedAt: new Date().toISOString().slice(0, 10),
    location: '',
  };
}

function NotesContent({ notes, onOpenUrl }: { notes: string; onOpenUrl(url: string): void }) {
  if (!notes) return <p className="detail-copy">暂无备注</p>;
  const parts = notes.split(/(https?:\/\/[^\s]+)/g);
  return (
    <p className="detail-copy">
      {parts.map((part, index) => /^https?:\/\//.test(part) ? (
        <button
          key={`${part}-${index}`}
          type="button"
          className="detail-note-link"
          onClick={() => onOpenUrl(part)}
        >
          {part}
        </button>
      ) : <React.Fragment key={`${part}-${index}`}>{part}</React.Fragment>)}
    </p>
  );
}

function panelTitle(mode: RecordPanelMode): string {
  return mode === 'new' ? '新建投递记录' : mode === 'edit' ? '编辑投递记录' : '投递详情';
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value || '未记录' : date.toLocaleString('zh-CN', { hour12: false });
}

function formatEventTime(event: ApplicationEvent): string {
  return event.timePrecision === 'date' ? event.occurredAt.slice(0, 10) : formatTime(event.occurredAt);
}

function sourceLabel(source: ApplicationEvent['source']): string {
  return ({ manual: '手动记录', website: '招聘网页', email: '招聘邮件', migration: '旧数据迁移' })[source];
}
