import React from 'react';
import type { ApplicationRecordStatus } from '../../../src/shared/types.ts';
import type { PipelineCount, StatusFilter } from './recordsView.ts';

interface PipelineRailProps {
  total: number;
  active: number;
  favoriteCount: number;
  favoritesSelected: boolean;
  pendingMailCount: number;
  mailSelected: boolean;
  careerFairCount: number;
  upcomingCareerFairCount: number;
  careerFairsSelected: boolean;
  counts: PipelineCount[];
  selected: StatusFilter;
  onSelectFavorites(): void;
  onSelectMail(): void;
  onSelectCareerFairs(): void;
  onSelect(status: StatusFilter): void;
}

export function PipelineRail({
  total,
  active,
  favoriteCount,
  favoritesSelected,
  pendingMailCount,
  mailSelected,
  careerFairCount,
  upcomingCareerFairCount,
  careerFairsSelected,
  counts,
  selected,
  onSelectFavorites,
  onSelectMail,
  onSelectCareerFairs,
  onSelect,
}: PipelineRailProps) {
  return (
    <aside className="pipeline-rail" aria-label="投递状态筛选">
      <div className="pipeline-heading">
        <p>APPLICATION TRACK</p>
        <h2>投递轨道</h2>
      </div>
      <button
        type="button"
        className={`pipeline-mail-button${mailSelected ? ' is-active' : ''}`}
        onClick={onSelectMail}
        aria-label={`招聘邮箱 ${pendingMailCount} 封待审核`}
      >
        <span><strong>招聘邮箱</strong><small>人工审核后才更新岗位</small></span>
        <b>{pendingMailCount}</b>
      </button>
      <button
        type="button"
        className={`pipeline-fair-button${careerFairsSelected ? ' is-active' : ''}`}
        onClick={onSelectCareerFairs}
        aria-label={`招聘会 ${careerFairCount} 场`}
      >
        <span><strong>招聘会</strong><small>{upcomingCareerFairCount} 场待参加</small></span>
        <b>{careerFairCount}</b>
      </button>
      <button
        type="button"
        className={`pipeline-favorite-button${favoritesSelected ? ' is-active' : ''}`}
        onClick={onSelectFavorites}
        aria-label={`特别关注 ${favoriteCount} 条`}
      >
        <span><strong>特别关注</strong><small>想去的公司和岗位</small></span>
        <b>{favoriteCount}</b>
      </button>
      <button
        type="button"
        className={`pipeline-overview${!mailSelected && !careerFairsSelected && !favoritesSelected && selected === '全部' ? ' is-active' : ''}`}
        onClick={() => onSelect('全部')}
      >
        <span>全部记录</span><strong>{total}</strong>
      </button>
      <div className="pipeline-live-count"><span className="pulse-dot" />当前推进中 <strong>{active}</strong></div>
      <ol className="pipeline-list">
        {counts.map(({ status, filter, count }) => (
          <li key={status} className={statusClass(status)}>
            <button
              type="button"
              className={selected === filter ? 'is-active' : ''}
              onClick={() => onSelect(filter)}
              aria-label={status === '已投递' ? `已投递汇总 ${count} 条` : undefined}
            >
              <span className="pipeline-node" aria-hidden="true" />
              <span className="pipeline-label">{status}</span>
              <strong>{count}</strong>
            </button>
          </li>
        ))}
      </ol>
      <p className="pipeline-note">桌面端只管理记录；网页识别和自动填表继续由浏览器扩展负责。</p>
    </aside>
  );
}

function statusClass(status: ApplicationRecordStatus): string {
  if (status === 'offer') return 'is-offer';
  if (['主动放弃', '职位关闭', '终止'].includes(status)) return 'is-terminal';
  return '';
}
