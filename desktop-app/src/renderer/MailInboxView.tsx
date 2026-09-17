import React, { useEffect, useMemo, useState } from 'react';
import type { ApplicationRecord } from '../../../src/shared/types.ts';
import { DESKTOP_MAIL_REVIEW_STAGES } from '../domain/desktopMail.ts';
import type {
  DesktopMailInboxState,
  DesktopMailReview,
  DesktopMailReviewDecisionInput,
  DesktopMailReviewStage,
} from '../shared/contracts.ts';
import { ExternalIcon, SearchIcon, SyncIcon } from './Icons.tsx';

interface MailInboxViewProps {
  inbox: DesktopMailInboxState;
  records: ApplicationRecord[];
  busy: boolean;
  onScan(): void;
  onConfirm(input: DesktopMailReviewDecisionInput): void;
  onIgnore(reviewId: string): void;
  onIgnoreMany(reviewIds: string[]): void;
  onOpenUrl(url: string): void;
}

type ReviewFilter = 'pending' | 'all' | 'confirmed' | 'ignored';

export function MailInboxView(props: MailInboxViewProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ReviewFilter>('pending');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const visible = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return props.inbox.reviews.filter(review => (
      (filter === 'all' || review.state === filter)
      && (!keyword || [review.subject, review.from, review.summary, review.companyName]
        .some(value => String(value ?? '').toLocaleLowerCase().includes(keyword)))
    ));
  }, [filter, props.inbox.reviews, query]);
  const selectableIds = useMemo(
    () => visible.filter(review => review.state === 'pending').map(review => review.id),
    [visible],
  );
  const pendingIds = useMemo(
    () => new Set(props.inbox.reviews
      .filter(review => review.state === 'pending')
      .map(review => review.id)),
    [props.inbox.reviews],
  );
  const activeSelectedIds = useMemo(
    () => selectedIds.filter(id => pendingIds.has(id)),
    [pendingIds, selectedIds],
  );
  const allVisibleSelected = selectableIds.length > 0
    && selectableIds.every(id => activeSelectedIds.includes(id));

  return (
    <main className="records-workbench mail-inbox-workbench">
      <div className="workbench-heading">
        <div><p>RECRUITMENT MAIL / REVIEW</p><h1>招聘邮箱</h1><span>邮件只进入待审核；系统不会自动修改任何投递岗位状态。</span></div>
        <div className="workbench-actions">
          <button type="button" className="button-primary mail-scan-button" disabled={props.busy || props.inbox.status === 'scanning'} onClick={props.onScan}>
            <SyncIcon />{props.inbox.status === 'scanning' ? '扫描中…' : '扫描邮箱'}
          </button>
        </div>
      </div>

      <section className={`mail-connection-card status-${props.inbox.status}`}>
        <span className="sync-indicator" />
        <div><strong>{connectionTitle(props.inbox)}</strong><small>{connectionDetail(props.inbox)}</small></div>
        <div className="mail-account-pills">{props.inbox.accounts.map(account => <span key={account.id} className={account.connection === 'error' ? 'is-error' : ''}>{account.emailAddress}</span>)}</div>
      </section>

      <div className="records-toolbar mail-toolbar">
        <label className="search-field"><SearchIcon /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索公司、主题、发件人或邮件摘要…" aria-label="搜索招聘邮件" /></label>
        <div className="mail-review-filters" role="group" aria-label="审核状态筛选">
          <FilterButton value="pending" current={filter} onSelect={setFilter}>待审核 {props.inbox.pendingCount}</FilterButton>
          <FilterButton value="all" current={filter} onSelect={setFilter}>全部</FilterButton>
          <FilterButton value="confirmed" current={filter} onSelect={setFilter}>已确认</FilterButton>
          <FilterButton value="ignored" current={filter} onSelect={setFilter}>已忽略</FilterButton>
        </div>
      </div>
      {selectableIds.length > 0 && (
        <div className="mail-batch-toolbar" aria-label="招聘邮件批量操作">
          <button
            type="button"
            className="button-secondary"
            disabled={props.busy}
            onClick={() => setSelectedIds(current => allVisibleSelected
              ? current.filter(id => !selectableIds.includes(id))
              : [...new Set([...current, ...selectableIds])])}
          >
            {allVisibleSelected ? '取消全选' : `全选当前 ${selectableIds.length} 封`}
          </button>
          <span>已选择 {activeSelectedIds.length} 封；忽略不会修改岗位状态</span>
          <button
            type="button"
            className="button-secondary mail-batch-ignore"
            disabled={props.busy || activeSelectedIds.length === 0}
            onClick={() => props.onIgnoreMany(activeSelectedIds)}
          >
            批量忽略（{activeSelectedIds.length}）
          </button>
        </div>
      )}

      {visible.length ? (
        <div className="mail-review-list">
          {visible.map(review => (
            <MailReviewCard
              key={review.id}
              review={review}
              records={props.records}
              busy={props.busy}
              onConfirm={props.onConfirm}
              onIgnore={props.onIgnore}
              selected={activeSelectedIds.includes(review.id)}
              onSelectionChange={selected => setSelectedIds(current => selected
                ? [...new Set([...current, review.id])]
                : current.filter(id => id !== review.id))}
              onOpenUrl={props.onOpenUrl}
            />
          ))}
        </div>
      ) : (
        <section className="records-empty"><div className="mail-empty-glyph">✓</div><h3>{emptyTitle(props.inbox, filter, query)}</h3><p>{emptyDetail(props.inbox, filter)}</p></section>
      )}
    </main>
  );
}

function MailReviewCard(props: {
  review: DesktopMailReview;
  records: ApplicationRecord[];
  busy: boolean;
  onConfirm(input: DesktopMailReviewDecisionInput): void;
  onIgnore(reviewId: string): void;
  selected: boolean;
  onSelectionChange(selected: boolean): void;
  onOpenUrl(url: string): void;
}) {
  const recordCandidates = useMemo(
    () => candidateRecords(props.review, props.records),
    [props.records, props.review.candidateRecordIds],
  );
  const [recordId, setRecordId] = useState(recordCandidates.length === 1 ? recordCandidates[0]!.id : '');
  const [recordQuery, setRecordQuery] = useState('');
  const [stage, setStage] = useState<DesktopMailReviewStage | ''>(props.review.suggestedStage ?? '');
  const [scheduleType, setScheduleType] = useState<'start' | 'deadline'>(
    defaultReviewScheduleType(props.review, props.review.suggestedStage),
  );
  const [scheduledAt, setScheduledAt] = useState(
    reviewTimeValue(props.review, defaultReviewScheduleType(props.review, props.review.suggestedStage)),
  );
  const [actionUrl, setActionUrl] = useState(props.review.actionUrl ?? '');
  const [notes, setNotes] = useState('');
  const selectedRecord = props.records.find(record => record.id === props.review.selectedRecordId);
  const selectedStage = DESKTOP_MAIL_REVIEW_STAGES.find(item => item.value === props.review.selectedStage)?.label;
  const suggested = DESKTOP_MAIL_REVIEW_STAGES.find(item => item.value === props.review.suggestedStage)?.label;
  const searchedCandidates = useMemo(
    () => filterRecordCandidates(recordCandidates, recordQuery),
    [recordCandidates, recordQuery],
  );
  const selectedCandidate = recordCandidates.find(record => record.id === recordId);
  const visibleCandidates = selectedCandidate && !searchedCandidates.some(record => record.id === selectedCandidate.id)
    ? [selectedCandidate, ...searchedCandidates]
    : searchedCandidates;

  useEffect(() => {
    if (recordCandidates.length === 1) setRecordId(current => current || recordCandidates[0]!.id);
  }, [recordCandidates]);

  useEffect(() => {
    const suggestedTime = reviewTimeValue(props.review, scheduleType);
    if (suggestedTime) setScheduledAt(current => current || suggestedTime);
  }, [props.review.deadlineAt, props.review.extractedAt, scheduleType]);

  return (
    <article className={`mail-review-card state-${props.review.state}`}>
      <header>
        <div className="mail-review-title"><div><span>{categoryLabel(props.review.category)}</span>{props.review.companyName && <strong>{props.review.companyName}</strong>}</div><h2>{props.review.subject}</h2><p>{props.review.from} · {formatDateTime(props.review.receivedAt)}</p></div>
        <div className="mail-review-card-actions">
          {props.review.state === 'pending' && (
            <label className="mail-review-select">
              <input
                type="checkbox"
                checked={props.selected}
                disabled={props.busy}
                aria-label={`选择邮件 ${props.review.subject}`}
                onChange={event => props.onSelectionChange(event.target.checked)}
              />
              <span>选择</span>
            </label>
          )}
          <span className="mail-review-state">{reviewStateLabel(props.review.state)}</span>
        </div>
      </header>
      <p className="mail-summary">{props.review.summary || '邮件正文未提取到可显示摘要。'}</p>
      <div className="mail-review-facts">
        <span><strong>公司匹配</strong>{props.review.companyName ? `${props.review.companyName} · ${props.review.candidateRecordIds.length} 个投递岗位` : '未匹配，请人工选择'}</span>
        <span><strong>系统建议</strong>{suggested || '无法确定，请人工判断'}</span>
        {(props.review.extractedAt || props.review.deadlineAt) && <span><strong>识别时间</strong>{formatDateTime(props.review.extractedAt || props.review.deadlineAt || '')}</span>}
      </div>
      {props.review.actionUrl && <button type="button" className="mail-action-link" onClick={() => props.onOpenUrl(props.review.actionUrl!)}>打开邮件中的链接 <ExternalIcon /></button>}

      {props.review.state === 'pending' ? (
        <div className="mail-review-decision">
          <div className="mail-record-picker">
            <span>对应公司的投递岗位</span>
            <label className="mail-record-search">
              <SearchIcon />
              <input
                type="search"
                aria-label={`${props.review.subject} 搜索投递公司或岗位`}
                value={recordQuery}
                placeholder="搜索投递过的公司或岗位"
                onChange={event => {
                  const nextQuery = event.target.value;
                  const matches = filterRecordCandidates(recordCandidates, nextQuery);
                  setRecordQuery(nextQuery);
                  if (nextQuery.trim() && matches.length === 1) setRecordId(matches[0]!.id);
                }}
              />
            </label>
            <select aria-label={`${props.review.subject} 对应投递岗位`} value={recordId} onChange={event => setRecordId(event.target.value)}><option value="">请选择要更新的岗位</option>{visibleCandidates.map(record => <option key={record.id} value={record.id}>{record.companyName} · {record.jobTitle} · 当前 {record.status}</option>)}</select>
            {recordQuery && <small className={searchedCandidates.length ? '' : 'is-missing'}>{searchedCandidates.length ? `找到 ${searchedCandidates.length} 个投递岗位` : '没有找到，请换个公司名或岗位关键词'}</small>}
          </div>
          <label><span>邮件阶段（系统已预选，请确认）</span><select aria-label={`${props.review.subject} 邮件阶段`} value={stage} onChange={event => {
            const nextStage = event.target.value as DesktopMailReviewStage | '';
            const nextType = defaultReviewScheduleType(props.review, nextStage || props.review.suggestedStage);
            setStage(nextStage);
            setScheduleType(nextType);
            setScheduledAt(reviewTimeValue(props.review, nextType));
          }}><option value="">请选择实际阶段</option>{DESKTOP_MAIL_REVIEW_STAGES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <label>
            <span>时间含义</span>
            <select
              aria-label={`${props.review.subject} 时间含义`}
              value={scheduleType}
              disabled={Boolean(stage) && !isScheduledReviewStage(stage)}
              onChange={event => {
                const nextType = event.target.value as 'start' | 'deadline';
                setScheduleType(nextType);
                setScheduledAt(reviewTimeValue(props.review, nextType));
              }}
            >
              <option value="deadline">截止时间</option>
              <option value="start">开始时间</option>
            </select>
          </label>
          <label>
            <span>{scheduleType === 'deadline' ? '截止日期与时间' : '开始日期与时间'}</span>
            <input
              type="datetime-local"
              aria-label={`${props.review.subject} 安排时间`}
              value={scheduledAt}
              onChange={event => setScheduledAt(event.target.value)}
            />
            <small className={scheduledAt ? 'mail-time-hint' : 'mail-time-hint is-missing'}>
              {scheduledAt ? '已按邮件内容预填，请核对后确认' : '未识别到时间，请根据邮件补充'}
            </small>
          </label>
          <label>
            <span>测评 / 面试链接</span>
            <input
              type="url"
              aria-label={`${props.review.subject} 链接地址`}
              value={actionUrl}
              placeholder="https://"
              onChange={event => setActionUrl(event.target.value)}
            />
          </label>
          <label>
            <span>补充备注</span>
            <textarea
              rows={2}
              aria-label={`${props.review.subject} 补充备注`}
              value={notes}
              placeholder="可填写准备事项、账号或其他说明"
              onChange={event => setNotes(event.target.value)}
            />
          </label>
          <div className="mail-review-decision-actions"><button type="button" className="button-secondary" disabled={props.busy} onClick={() => props.onIgnore(props.review.id)}>忽略此邮件</button><button type="button" className="button-primary" disabled={props.busy || !recordId || !stage || (isScheduledReviewStage(stage) && !scheduledAt)} onClick={() => stage && props.onConfirm({ reviewId: props.review.id, recordId, stage, scheduledAt, scheduleType, actionUrl, notes })}>确认并更新岗位</button></div>
        </div>
      ) : (
        <p className="mail-review-result">{props.review.state === 'confirmed' ? `已更新：${selectedRecord?.companyName ?? '原公司'} · ${selectedRecord?.jobTitle ?? '原岗位'} · ${selectedStage ?? '已确认'}` : '该邮件已人工忽略，未修改投递状态。'}</p>
      )}
    </article>
  );
}

function isScheduledReviewStage(stage: DesktopMailReviewStage | ''): boolean {
  return ['writtenTest', 'assessment', 'ai', 'first', 'second', 'third', 'hr'].includes(stage);
}

function defaultReviewScheduleType(
  review: DesktopMailReview,
  stage: DesktopMailReviewStage | undefined,
): 'start' | 'deadline' {
  if (stage === 'assessment' || stage === 'ai') return 'deadline';
  if (stage === 'writtenTest' && review.deadlineAt && !review.extractedAt) return 'deadline';
  return 'start';
}

function reviewTimeValue(review: DesktopMailReview, type: 'start' | 'deadline'): string {
  return toDateTimeLocal(type === 'deadline'
    ? review.deadlineAt ?? review.extractedAt
    : review.extractedAt ?? review.deadlineAt);
}

function toDateTimeLocal(value: string | undefined): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) return '';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(normalized)) {
    return normalized.slice(0, 16);
  }
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '';
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
  return `${day}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function candidateRecords(review: DesktopMailReview, records: readonly ApplicationRecord[]): ApplicationRecord[] {
  const ids = new Set(review.candidateRecordIds);
  const matched = records.filter(record => ids.has(record.id));
  return (matched.length ? matched : records).slice().sort((left, right) => (
    left.companyName.localeCompare(right.companyName, 'zh-CN')
    || left.jobTitle.localeCompare(right.jobTitle, 'zh-CN')
  ));
}

function filterRecordCandidates(records: readonly ApplicationRecord[], query: string): ApplicationRecord[] {
  const keyword = query.normalize('NFKC').trim().toLocaleLowerCase();
  if (!keyword) return [...records];
  return records.filter(record => [record.companyName, record.jobTitle].some(value => (
    value.normalize('NFKC').toLocaleLowerCase().includes(keyword)
  )));
}

function FilterButton(props: { value: ReviewFilter; current: ReviewFilter; onSelect(value: ReviewFilter): void; children: React.ReactNode }) {
  return <button type="button" className={props.current === props.value ? 'is-active' : ''} onClick={() => props.onSelect(props.value)}>{props.children}</button>;
}

function connectionTitle(inbox: DesktopMailInboxState): string {
  if (inbox.status === 'scanning') return '正在扫描招聘邮件';
  if (inbox.status === 'unavailable') return '尚未接入本地邮箱';
  if (inbox.status === 'error') return '邮箱连接或扫描失败';
  if (inbox.accounts.some(account => account.connection === 'connected')) return '招聘邮箱已连接';
  return '等待首次邮箱扫描';
}

function connectionDetail(inbox: DesktopMailInboxState): string {
  if (inbox.lastError) return inbox.lastError;
  if (!inbox.lastScannedAt) return '打开桌面端后会自动扫描，也可以手动扫描';
  return `上次扫描 ${formatDateTime(inbox.lastScannedAt)}`;
}

function categoryLabel(category: string): string {
  return ({
    application_received: '投递确认', assessment_invite: '笔试/测评候选', interview_invite: '面试候选',
    offer: 'Offer 候选', rejection: '未通过候选', job_closed: '职位关闭候选',
    recruiter_message: '招聘沟通', unknown: '待人工识别',
  } as Record<string, string>)[category] ?? '招聘邮件';
}

function reviewStateLabel(state: DesktopMailReview['state']): string {
  return ({ pending: '待审核', confirmed: '已确认', ignored: '已忽略' })[state];
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function emptyTitle(inbox: DesktopMailInboxState, filter: ReviewFilter, query: string): string {
  if (query) return '没有匹配的招聘邮件';
  if (inbox.status === 'unavailable') return '还没有可用邮箱账号';
  if (filter === 'pending') return '暂时没有待审核邮件';
  return '该分类暂时没有邮件';
}

function emptyDetail(inbox: DesktopMailInboxState, filter: ReviewFilter): string {
  if (inbox.status === 'unavailable') return '先在 Edge 扩展设置中配置本地邮箱账号和授权码。';
  if (filter === 'pending') return '邮件只会进入待审核，不会自动修改岗位状态。';
  return '切换其他审核状态查看。';
}
