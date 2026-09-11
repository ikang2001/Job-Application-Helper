import React, { useEffect, useMemo, useState } from 'react';
import type { ApplicationRecord } from '../../../src/shared/types.ts';
import type { DesktopReminderState } from '../shared/contracts.ts';
import { CalendarIcon, CloseIcon, ExternalIcon } from './Icons.tsx';
import {
  completedRecruitmentSchedules,
  filterRecruitmentSchedules,
  formatScheduleTime,
  scheduleDisplayLabel,
  upcomingRecruitmentSchedules,
  type RecruitmentScheduleCategoryFilter,
  type UpcomingRecruitmentSchedule,
} from './recruitmentSchedule.ts';

const SCHEDULE_CATEGORIES: readonly { value: RecruitmentScheduleCategoryFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'assessment', label: '测评 / 笔试' },
  { value: 'ai', label: 'AI 面试' },
  { value: 'interview', label: '正式面试' },
];

interface UpcomingSchedulePanelProps {
  records: readonly ApplicationRecord[];
  reminder: DesktopReminderState;
  reminderBusy: boolean;
  completionBusy: boolean;
  onClose(): void;
  onToggleReminder(): void;
  onOpenRecord(recordId: string): void;
  onOpenUrl(url: string): void;
  onSetCompleted(item: UpcomingRecruitmentSchedule, completed: boolean): void;
}

export function UpcomingSchedulePanel(props: UpcomingSchedulePanelProps) {
  const [now, setNow] = useState(Date.now());
  const [view, setView] = useState<'pending' | 'completed'>('pending');
  const [category, setCategory] = useState<RecruitmentScheduleCategoryFilter>('all');
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const items = useMemo(
    () => upcomingRecruitmentSchedules(props.records, now),
    [now, props.records],
  );
  const completedItems = useMemo(
    () => completedRecruitmentSchedules(props.records),
    [props.records],
  );
  const visibleItems = useMemo(
    () => filterRecruitmentSchedules(items, category),
    [category, items],
  );
  const next = visibleItems[0];

  return (
    <div className="panel-backdrop">
      <aside className="settings-panel upcoming-panel" role="dialog" aria-modal="true" aria-label="近期安排">
        <header className="panel-header">
          <div><p>NEXT UP</p><h2>近期安排</h2></div>
          <button type="button" className="square-button" onClick={props.onClose} aria-label="关闭"><CloseIcon /></button>
        </header>
        <div className={`upcoming-reminder-strip ${props.reminder.enabled ? 'is-enabled' : 'is-disabled'}`}>
          <BellStatus enabled={props.reminder.enabled} />
          <div>
            <strong>{props.reminder.enabled ? '桌面弹窗提醒已开启' : '桌面弹窗提醒已关闭'}</strong>
            <p>{props.reminder.enabled ? '每项安排提前 24 小时和 5 小时提醒。' : '日程仍会保留在这里，手机提醒不受影响。'}</p>
          </div>
          <button type="button" onClick={props.onToggleReminder} disabled={props.reminderBusy || !props.reminder.supported}>
            {props.reminder.enabled ? '关闭弹窗' : '开启弹窗'}
          </button>
        </div>

        <div className="schedule-view-tabs" role="tablist" aria-label="安排状态">
          <button type="button" role="tab" aria-selected={view === 'pending'} className={view === 'pending' ? 'is-active' : ''} onClick={() => setView('pending')}>待处理 <span>{items.length}</span></button>
          <button type="button" role="tab" aria-selected={view === 'completed'} className={view === 'completed' ? 'is-active' : ''} onClick={() => setView('completed')}>已完成 <span>{completedItems.length}</span></button>
        </div>

        {view === 'pending' && (
          <nav className="schedule-category-tabs" aria-label="安排分类">
            {SCHEDULE_CATEGORIES.map(option => (
              <button
                key={option.value}
                type="button"
                className={category === option.value ? 'is-active' : ''}
                aria-pressed={category === option.value}
                onClick={() => setCategory(option.value)}
              >
                {option.label}
                <span>{filterRecruitmentSchedules(items, option.value).length}</span>
              </button>
            ))}
          </nav>
        )}

        {view === 'pending' && next ? (
          <div className="upcoming-content">
            <NextScheduleTicket
              item={next}
              now={now}
              onOpenRecord={props.onOpenRecord}
              onOpenUrl={props.onOpenUrl}
              onSetCompleted={props.onSetCompleted}
              completionBusy={props.completionBusy}
            />
            <section className="upcoming-timeline-section">
              <div className="upcoming-section-heading">
                <div><span>时间轨道</span><h3>{visibleItems.length === 1 ? '当前分类只有这一项安排' : `当前分类随后还有 ${visibleItems.length - 1} 项`}</h3></div>
                <small>按开始或截止时间排序</small>
              </div>
              {visibleItems.length > 1 && (
                <ol className="upcoming-timeline">
                  {visibleItems.slice(1).map(item => (
                    <li key={`${item.recordId}:${item.kind}:${item.scheduledAt}`}>
                      <time><strong>{dayNumber(item.eventAt)}</strong><span>{monthLabel(item.eventAt)}</span></time>
                      <div>
                        <div><span>{item.companyName}</span><strong>{scheduleLabel(item)}</strong></div>
                        <h4>{item.jobTitle}</h4>
                        <p>{formatFullScheduleTime(item.eventAt)} · {countdownLabel(item, now)}</p>
                      </div>
                      <div className="upcoming-row-actions">
                        {item.url && <button type="button" onClick={() => props.onOpenUrl(item.url)} aria-label={`打开${scheduleLabel(item)}链接`}><ExternalIcon /></button>}
                        <button type="button" onClick={() => props.onOpenRecord(item.recordId)}>查看岗位</button>
                        <button type="button" className="complete-schedule-button" disabled={props.completionBusy} onClick={() => props.onSetCompleted(item, true)}>✓ 完成</button>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        ) : view === 'pending' ? (
          <div className="upcoming-empty">
            <span><CalendarIcon size={24} /></span>
            <h3>{category === 'all' ? '还没有即将到来的安排' : '当前分类暂无近期安排'}</h3>
            <p>{category === 'all' ? '从招聘邮件确认时间，或在岗位记录中填写笔试、测评和面试时间后，会自动出现在这里。' : '可以切换其他分类查看；各分类均按开始或截止时间从近到远排列。'}</p>
          </div>
        ) : completedItems.length ? (
          <CompletedScheduleList
            items={completedItems}
            busy={props.completionBusy}
            onOpenRecord={props.onOpenRecord}
            onSetCompleted={props.onSetCompleted}
          />
        ) : (
          <div className="upcoming-empty">
            <span className="completed-empty-icon">✓</span>
            <h3>还没有标记完成的安排</h3>
            <p>完成笔试、测评或面试后，在“待处理”中点击“已完成”，后续提醒会立即停止。</p>
          </div>
        )}
      </aside>
    </div>
  );
}

function NextScheduleTicket(props: {
  item: UpcomingRecruitmentSchedule;
  now: number;
  onOpenRecord(recordId: string): void;
  onOpenUrl(url: string): void;
  onSetCompleted(item: UpcomingRecruitmentSchedule, completed: boolean): void;
  completionBusy: boolean;
}) {
  const { item } = props;
  return (
    <section className="next-schedule-ticket">
      <div className="ticket-date">
        <span>{monthLabel(item.eventAt)}</span>
        <strong>{dayNumber(item.eventAt)}</strong>
        <small>{weekdayLabel(item.eventAt)}</small>
      </div>
      <div className="ticket-main">
        <div className="ticket-kicker"><span>下一项</span><strong>{scheduleLabel(item)}</strong></div>
        <h3>{item.companyName}</h3>
        <p>{item.jobTitle}</p>
        <time>{formatScheduleTime(item.scheduledAt)}</time>
        <div className="ticket-actions">
          <button type="button" className="button-secondary" onClick={() => props.onOpenRecord(item.recordId)}>查看岗位</button>
          {item.url && <button type="button" className="button-primary" onClick={() => props.onOpenUrl(item.url)}>打开安排链接 <ExternalIcon /></button>}
          <button type="button" className="ticket-complete-button" disabled={props.completionBusy} onClick={() => props.onSetCompleted(item, true)}>✓ 标记已完成</button>
        </div>
      </div>
      <div className="ticket-countdown"><small>{item.timeKind === 'deadline' ? '距离截止' : item.timeKind === 'start' ? '距离开始' : '距离安排'}</small><strong>{countdownValue(item.eventAt, props.now)}</strong></div>
    </section>
  );
}

function CompletedScheduleList(props: {
  items: readonly UpcomingRecruitmentSchedule[];
  busy: boolean;
  onOpenRecord(recordId: string): void;
  onSetCompleted(item: UpcomingRecruitmentSchedule, completed: boolean): void;
}) {
  return (
    <div className="completed-schedule-content">
      <div className="upcoming-section-heading">
        <div><span>COMPLETED</span><h3>已经停止提醒的安排</h3></div>
        <small>误操作可以撤销</small>
      </div>
      <ol className="completed-schedule-list">
        {props.items.map(item => (
          <li key={`${item.recordId}:${item.kind}:${item.scheduledAt}:completed`}>
            <span className="completed-check" aria-hidden="true">✓</span>
            <div>
              <div><span>{item.companyName}</span><strong>{scheduleLabel(item)}</strong></div>
              <h4>{item.jobTitle}</h4>
              <p>原安排：{formatFullScheduleTime(item.eventAt)} · 完成于 {formatCompletedTime(item.completedAt)}</p>
            </div>
            <div className="upcoming-row-actions">
              <button type="button" onClick={() => props.onOpenRecord(item.recordId)}>查看岗位</button>
              <button type="button" disabled={props.busy} onClick={() => props.onSetCompleted(item, false)}>撤销完成</button>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function BellStatus({ enabled }: { enabled: boolean }) {
  return <span className="upcoming-bell" aria-hidden="true"><i className={enabled ? '' : 'is-off'} /></span>;
}

function scheduleLabel(item: UpcomingRecruitmentSchedule): string {
  return scheduleDisplayLabel(item.label, {
    scheduledAt: item.scheduledAt,
    url: item.url,
    timeKind: item.timeKind,
    completedAt: item.completedAt,
  });
}

function formatCompletedTime(value: string | undefined): string {
  if (!value) return '未知时间';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function countdownLabel(item: UpcomingRecruitmentSchedule, now: number): string {
  const action = item.timeKind === 'deadline' ? '截止' : item.timeKind === 'start' ? '开始' : '到时';
  return `${countdownValue(item.eventAt, now)}后${action}`;
}

function countdownValue(eventAt: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((eventAt - now) / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours} 小时`;
  return `${Math.ceil(hours / 24)} 天`;
}

function dateValue(eventAt: number): Date {
  return new Date(eventAt);
}

function dayNumber(eventAt: number): string {
  return String(dateValue(eventAt).getDate()).padStart(2, '0');
}

function monthLabel(eventAt: number): string {
  return `${String(dateValue(eventAt).getMonth() + 1).padStart(2, '0')}月`;
}

function weekdayLabel(eventAt: number): string {
  return new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(dateValue(eventAt));
}

function formatFullScheduleTime(eventAt: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(dateValue(eventAt));
}
