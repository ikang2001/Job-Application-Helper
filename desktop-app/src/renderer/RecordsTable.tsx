import React, { useState } from 'react';
import { APPLICATION_RECORD_STATUSES } from '../../../src/shared/applicationRecords.ts';
import type { ApplicationRecord, ApplicationRecordStatus } from '../../../src/shared/types.ts';
import { ExternalIcon } from './Icons.tsx';
import { formatScheduleTime, RECRUITMENT_SCHEDULE_ROWS, scheduleDisplayLabel, scheduleEntry } from './recruitmentSchedule.ts';

export interface RecordsTableProps {
  records: ApplicationRecord[];
  selectedId?: string;
  busy: boolean;
  savingRecordId?: string;
  favoriteRecordIds: ReadonlySet<string>;
  savingFavoriteRecordId?: string;
  onSelect(record: ApplicationRecord): void;
  onToggleFavorite(record: ApplicationRecord, favorite: boolean): void;
  onOpenUrl(url: string): void;
  onStatusChange(record: ApplicationRecord, status: ApplicationRecordStatus): void;
  onSaveNotes(record: ApplicationRecord, notes: string): void;
  onEditSchedule(record: ApplicationRecord): void;
}

export function RecordsTable({
  records,
  selectedId,
  busy,
  savingRecordId,
  favoriteRecordIds,
  savingFavoriteRecordId,
  onSelect,
  onToggleFavorite,
  onOpenUrl,
  onStatusChange,
  onSaveNotes,
  onEditSchedule,
}: RecordsTableProps) {
  if (records.length === 0) {
    return (
      <div className="records-empty">
        <div className="empty-orbit" aria-hidden="true"><span /></div>
        <h3>这里还没有符合条件的记录</h3>
        <p>新建一条记录，或者从浏览器扩展导出的 JSON / CSV 中导入。</p>
      </div>
    );
  }

  return (
    <div className="records-table-shell">
      <table className="records-table">
        <thead>
          <tr>
            <th>公司与岗位</th>
            <th>状态</th>
            <th>安排 / 备注</th>
            <th>投递日期</th>
            <th>地点</th>
            <th>来源</th>
            <th>最近更新</th>
          </tr>
        </thead>
        <tbody>
          {records.map(record => (
            <tr
              key={record.id}
              className={selectedId === record.id ? 'is-selected' : ''}
              onClick={() => onSelect(record)}
            >
              <td>
                <div className="record-identity-cell">
                  <button
                    type="button"
                    className={`favorite-toggle${favoriteRecordIds.has(record.id) ? ' is-favorite' : ''}`}
                    disabled={busy || savingFavoriteRecordId === record.id}
                    aria-label={`${favoriteRecordIds.has(record.id) ? '取消收藏' : '收藏'} ${record.companyName} ${record.jobTitle}`}
                    aria-pressed={favoriteRecordIds.has(record.id)}
                    title={favoriteRecordIds.has(record.id) ? '取消特别关注' : '加入特别关注'}
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleFavorite(record, !favoriteRecordIds.has(record.id));
                    }}
                  >
                    {favoriteRecordIds.has(record.id) ? '★' : '☆'}
                  </button>
                  <button type="button" className="record-primary" onClick={() => onSelect(record)} disabled={busy}>
                    <strong>{record.companyName || '未填写公司'}</strong>
                    <span>{record.jobTitle || '未填写岗位'}</span>
                  </button>
                </div>
              </td>
              <td>
                <select
                  className={`quick-status ${statusClass(record.status)}`}
                  value={record.status}
                  disabled={busy || savingRecordId === record.id}
                  aria-label={`${record.companyName} 投递状态`}
                  onClick={event => event.stopPropagation()}
                  onChange={(event) => {
                    event.stopPropagation();
                    onStatusChange(record, event.target.value as ApplicationRecordStatus);
                  }}
                >
                  {APPLICATION_RECORD_STATUSES.map(status => <option key={status}>{status}</option>)}
                </select>
              </td>
              <td>
                <QuickSchedule
                  record={record}
                  disabled={busy || Boolean(savingRecordId)}
                  onEdit={onEditSchedule}
                  onOpenUrl={onOpenUrl}
                />
                <QuickNotes
                  key={`${record.id}:${record.updatedAt}`}
                  record={record}
                  disabled={busy || Boolean(savingRecordId)}
                  saving={savingRecordId === record.id}
                  onSave={onSaveNotes}
                  onOpenUrl={onOpenUrl}
                />
              </td>
              <td className="mono-cell">{record.appliedAt || '—'}</td>
              <td>{record.location || '—'}</td>
              <td>
                <div className="source-cell">
                  <span>{record.sourceSite || sourceHost(record.sourceUrl) || '手动记录'}</span>
                  {record.sourceUrl && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenUrl(record.sourceUrl);
                      }}
                      aria-label={`打开 ${record.companyName} 职位链接`}
                    >
                      <ExternalIcon />
                    </button>
                  )}
                </div>
              </td>
              <td className="mono-cell">{shortDate(record.updatedAt || record.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QuickSchedule({
  record,
  disabled,
  onEdit,
  onOpenUrl,
}: {
  record: ApplicationRecord;
  disabled: boolean;
  onEdit(record: ApplicationRecord): void;
  onOpenUrl(url: string): void;
}) {
  const entries = RECRUITMENT_SCHEDULE_ROWS.map(row => ({
    ...row,
    entry: scheduleEntry(record.recruitmentSchedule, row),
  })).filter(({ entry }) => entry.scheduledAt || entry.url);
  return (
    <div className="quick-schedule" onClick={event => event.stopPropagation()}>
      <div>
        {entries.map(({ kind, label, entry }) => (
          <span key={kind} className={`quick-schedule-item${entry.completedAt ? ' is-completed' : ''}`}>
            <strong>{scheduleDisplayLabel(label, entry)}</strong>
            <time>{entry.scheduledAt ? formatScheduleTime(entry.scheduledAt) : '时间待定'}</time>
            {entry.url && (
              <button
                type="button"
                disabled={disabled}
                aria-label={`打开 ${record.companyName} ${label}链接`}
                title={`打开${label}链接`}
                onClick={() => onOpenUrl(entry.url)}
              >
                <ExternalIcon />
              </button>
            )}
          </span>
        ))}
        {entries.length === 0 && <span className="quick-schedule-empty">尚未填写安排</span>}
      </div>
      <button
        type="button"
        className="quick-schedule-edit"
        disabled={disabled}
        onClick={() => onEdit(record)}
      >
        {entries.length ? '编辑安排' : '＋ 填写安排'}
      </button>
    </div>
  );
}

function QuickNotes({
  record,
  disabled,
  saving,
  onSave,
  onOpenUrl,
}: {
  record: ApplicationRecord;
  disabled: boolean;
  saving: boolean;
  onSave(record: ApplicationRecord, notes: string): void;
  onOpenUrl(url: string): void;
}) {
  const [notes, setNotes] = useState(record.notes);
  const changed = notes.trim() !== record.notes;
  const link = firstHttpUrl(record.notes);
  return (
    <form
      className="quick-notes"
      onClick={event => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (changed && !disabled) onSave(record, notes);
      }}
    >
      <input
        value={notes}
        disabled={disabled}
        aria-label={`${record.companyName} 备注`}
        placeholder="填写补充备注或跟进事项"
        onChange={event => setNotes(event.target.value)}
      />
      <button
        type="submit"
        disabled={disabled || !changed}
        aria-label={`保存 ${record.companyName} 备注`}
      >
        {saving ? '保存中…' : '保存'}
      </button>
      {link && (
        <button
          type="button"
          className="quick-notes-open"
          disabled={disabled}
          aria-label={`打开 ${record.companyName} 备注链接`}
          title="用默认浏览器打开备注中的链接"
          onClick={(event) => {
            event.stopPropagation();
            onOpenUrl(link);
          }}
        >
          <ExternalIcon />
        </button>
      )}
    </form>
  );
}

function firstHttpUrl(notes: string): string {
  const matched = notes.match(/https?:\/\/[^\s<>"']+/i)?.[0] ?? '';
  return matched.replace(/[.,;!?，。；！？》】]+$/u, '');
}

function statusClass(status: ApplicationRecord['status']): string {
  if (status === 'offer') return 'status-offer';
  if (status === '面试中') return 'status-interview';
  if (status === '笔试/测评') return 'status-assessment';
  if (['已拒绝', '主动放弃', '职位关闭', '终止'].includes(status)) return 'status-terminal';
  return 'status-active';
}

function sourceHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return '';
  }
}

function shortDate(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 10) : date.toLocaleDateString('zh-CN');
}
