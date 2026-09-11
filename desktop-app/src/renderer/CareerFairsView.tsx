import React, { useMemo, useState } from 'react';
import type { CareerFair } from '../shared/contracts.ts';
import { filterAndSortCareerFairs, upcomingCareerFairCount } from '../domain/careerFairs.ts';
import { ExternalIcon, SearchIcon } from './Icons.tsx';

interface CareerFairsViewProps {
  careerFairs: CareerFair[];
  busy: boolean;
  onNew(): void;
  onEdit(careerFair: CareerFair): void;
  onDelete(careerFair: CareerFair): void;
  onOpenUrl(url: string): void;
}

export function CareerFairsView(props: CareerFairsViewProps) {
  const [query, setQuery] = useState('');
  const visible = useMemo(
    () => filterAndSortCareerFairs(props.careerFairs, query),
    [props.careerFairs, query],
  );
  const upcoming = upcomingCareerFairCount(props.careerFairs);
  return (
    <main className="records-workbench career-fairs-workbench">
      <div className="workbench-heading">
        <div><p>CAREER FAIR / SCHEDULE</p><h1>招聘会</h1><span>{upcoming} 场待参加；即将开始的招聘会优先显示，过期活动保留在后面。</span></div>
        <div className="workbench-actions"><button type="button" className="button-primary new-record-button" disabled={props.busy} onClick={props.onNew}>＋ 新建招聘会</button></div>
      </div>
      <div className="records-toolbar">
        <label className="search-field"><SearchIcon /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索招聘会、地点、主办方、目标公司或岗位…" aria-label="搜索招聘会" /></label>
      </div>
      {visible.length ? (
        <div className="career-fair-grid">
          {visible.map(fair => (
            <article className="career-fair-card" key={fair.id}>
              <header><div><span>{fair.mode}</span><strong>{fair.status}</strong></div><h2>{fair.name}</h2></header>
              <dl>
                <Fact label="时间" value={formatRange(fair.startsAt, fair.endsAt)} />
                <Fact label="地点" value={fair.location} />
                <Fact label="主办方" value={fair.organizer} />
                <Fact label="报名截止" value={formatDateTime(fair.registrationDeadline)} />
                <Fact label="目标公司" value={fair.targetCompanies} />
                <Fact label="目标岗位" value={fair.targetRoles} />
              </dl>
              {fair.preparation && <p className="career-fair-preparation"><strong>准备：</strong>{fair.preparation}</p>}
              {fair.notes && <p className="career-fair-notes">{fair.notes}</p>}
              <footer>
                <div>{fair.eventUrl && <button type="button" className="button-secondary" onClick={() => props.onOpenUrl(fair.eventUrl)}>打开链接 <ExternalIcon /></button>}</div>
                <div><button type="button" className="button-secondary" disabled={props.busy} onClick={() => props.onEdit(fair)}>编辑</button><button type="button" className="button-danger" disabled={props.busy} onClick={() => props.onDelete(fair)}>删除</button></div>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <section className="records-empty"><div className="empty-orbit"><span /></div><h3>{query ? '没有匹配的招聘会' : '还没有招聘会安排'}</h3><p>{query ? '换一个关键词试试。' : '新建一场招聘会，把时间、地点和目标公司一起记下来。'}</p></section>
      )}
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value || '未记录'}</dd></div>;
}

function formatRange(startsAt: string, endsAt: string): string {
  const start = formatDateTime(startsAt);
  return endsAt ? `${start} — ${formatDateTime(endsAt)}` : start;
}

function formatDateTime(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
