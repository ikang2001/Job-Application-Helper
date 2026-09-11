import React from 'react';
import type { DesktopLocalSyncState, DesktopReminderState } from '../shared/contracts.ts';
import { BellIcon, CalendarIcon, SettingsIcon, SyncIcon } from './Icons.tsx';

interface AppHeaderProps {
  sync: DesktopLocalSyncState;
  reminder: DesktopReminderState;
  reminderBusy: boolean;
  upcomingCount: number;
  syncing: boolean;
  onToggleReminder(): void;
  onUpcoming(): void;
  onSync(): void;
  onMobile(): void;
  onSettings(): void;
}

export function AppHeader({
  sync,
  reminder,
  reminderBusy,
  upcomingCount,
  syncing,
  onToggleReminder,
  onUpcoming,
  onSync,
  onMobile,
  onSettings,
}: AppHeaderProps) {
  const reminderLabel = !reminder.supported
    ? '系统不支持'
    : reminder.enabled ? '已开启 · 24h / 5h' : '已关闭';
  return (
    <header className="app-header">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
        <div><strong>秋招投递管理器</strong><span>Job application desk</span></div>
      </div>
      <div className="header-actions">
        <div className="reminder-cluster">
          <button
            type="button"
            className={`reminder-status-button ${reminder.enabled ? 'is-enabled' : 'is-disabled'}`}
            onClick={onToggleReminder}
            disabled={reminderBusy || !reminder.supported}
            aria-pressed={reminder.enabled}
            aria-label={`桌面提醒${reminder.enabled ? '已开启，点击关闭' : '已关闭，点击开启'}`}
            title="只控制电脑弹窗，不影响手机提醒"
          >
            <BellIcon /><span><strong>桌面提醒</strong><small>{reminderBusy ? '正在保存…' : reminderLabel}</small></span><i aria-hidden="true" />
          </button>
          <button
            type="button"
            className="upcoming-entry-button"
            onClick={onUpcoming}
            aria-label={`查看近期安排，共 ${upcomingCount} 项`}
          >
            <CalendarIcon /><span><strong>近期安排</strong><small>{upcomingCount ? `${upcomingCount} 项待处理` : '暂无安排'}</small></span>
          </button>
        </div>
        <div className={`sync-caption status-${sync.status}`}>
          <span className="sync-indicator" />
          <div><strong>{syncLabel(sync, syncing)}</strong><small>{syncTime(sync)}</small></div>
        </div>
        <button type="button" className="icon-text-button" onClick={onSync} disabled={syncing}>
          <SyncIcon /><span>{syncing ? '同步中' : '立即同步'}</span>
        </button>
        <button type="button" className="icon-text-button mobile-view-button" onClick={onMobile}>
          <span className="phone-button-icon" aria-hidden="true" /><span>手机查看</span>
        </button>
        <button type="button" className="square-button" onClick={onSettings} aria-label="同步设置">
          <SettingsIcon />
        </button>
      </div>
    </header>
  );
}

function syncLabel(sync: DesktopLocalSyncState, syncing: boolean): string {
  if (syncing || sync.status === 'syncing') return '正在同步';
  return ({
    checking: '正在连接 Edge',
    synced: '已与 Edge 本机同步',
    error: '同步失败',
  })[sync.status];
}

function syncTime(sync: DesktopLocalSyncState): string {
  if (sync.lastError) return sync.lastError;
  if (!sync.lastSyncedAt) return '尚未完成同步';
  const date = new Date(sync.lastSyncedAt);
  return Number.isNaN(date.getTime()) ? sync.lastSyncedAt : `上次 ${date.toLocaleString('zh-CN', { hour12: false })}`;
}
