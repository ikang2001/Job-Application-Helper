import React, { useEffect, useMemo, useState } from 'react';
import type { ApplicationRecord, ApplicationRecordStatus } from '../../../src/shared/types.ts';
import type {
  CareerFair,
  DesktopCareerFairInput,
  DesktopMailReviewDecisionInput,
  DesktopMobileSyncSetupInput,
  DesktopRecordInput,
  DesktopState,
  DesktopWebDavInput,
} from '../shared/contracts.ts';
import { AppHeader } from './AppHeader.tsx';
import { CareerFairPanel } from './CareerFairPanel.tsx';
import { CareerFairsView } from './CareerFairsView.tsx';
import { CompanyRecordsView } from './CompanyRecordsView.tsx';
import { desktopRecordInput } from '../domain/records.ts';
import { MoreIcon, SearchIcon } from './Icons.tsx';
import { MobileSyncPanel } from './MobileSyncPanel.tsx';
import { MailInboxView } from './MailInboxView.tsx';
import { PipelineRail } from './PipelineRail.tsx';
import { RecordPanel } from './RecordPanel.tsx';
import { RecordsTable } from './RecordsTable.tsx';
import { UpcomingSchedulePanel } from './UpcomingSchedulePanel.tsx';
import { WebDavPanel } from './WebDavPanel.tsx';
import {
  activeApplicationCount,
  filterAndSortRecords,
  pipelineCounts,
  type RecordSort,
  type StatusFilter,
} from './recordsView.ts';
import { upcomingCareerFairCount } from '../domain/careerFairs.ts';
import {
  setRecruitmentScheduleCompleted,
  upcomingRecruitmentSchedules,
  type UpcomingRecruitmentSchedule,
} from './recruitmentSchedule.ts';

type PanelState =
  | { mode: 'new' }
  | { mode: 'view' | 'edit'; recordId: string }
  | null;

type Notice = { type: 'success' | 'error' | 'info'; text: string } | null;
type RecordViewMode = 'records' | 'companies';
type WorkspaceSection = 'mail-inbox' | 'career-fairs' | 'favorites' | 'applications';

const NOTICE_AUTO_DISMISS_MS = {
  success: 4_000,
  info: 5_000,
  error: 10_000,
} as const;

export function App() {
  const [state, setState] = useState<DesktopState | null>(null);
  const [startupError, setStartupError] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('全部');
  const [sort, setSort] = useState<RecordSort>('recent');
  const [viewMode, setViewMode] = useState<RecordViewMode>('records');
  const [section, setSection] = useState<WorkspaceSection>('applications');
  const [panel, setPanel] = useState<PanelState>(null);
  const [careerFairPanelId, setCareerFairPanelId] = useState<string | 'new' | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileSyncOpen, setMobileSyncOpen] = useState(false);
  const [upcomingOpen, setUpcomingOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [savingRecordId, setSavingRecordId] = useState('');
  const [savingFavoriteRecordId, setSavingFavoriteRecordId] = useState('');
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    let active = true;
    const stopListening = window.desktopApi.onStateChanged(nextState => {
      if (active) setState(nextState);
    });
    void window.desktopApi.getState().then((result) => {
      if (!active) return;
      if (result.success && result.data) setState(result.data);
      else setStartupError(result.error || '读取桌面端数据失败');
    });
    return () => {
      active = false;
      stopListening();
    };
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timeout = setTimeout(() => setNotice(null), NOTICE_AUTO_DISMISS_MS[notice.type]);
    return () => clearTimeout(timeout);
  }, [notice]);

  const favoriteRecordIds = useMemo(
    () => new Set(state?.favoriteRecordIds ?? []),
    [state?.favoriteRecordIds],
  );
  const visibleRecords = useMemo(() => {
    const records = section === 'favorites'
      ? (state?.records ?? []).filter(record => favoriteRecordIds.has(record.id))
      : state?.records ?? [];
    return filterAndSortRecords(records, query, status, sort);
  }, [favoriteRecordIds, query, section, sort, state?.records, status]);
  const upcomingCount = useMemo(
    () => upcomingRecruitmentSchedules(state?.records ?? []).length,
    [state?.records],
  );
  const selectedRecord = panel && 'recordId' in panel
    ? state?.records.find(record => record.id === panel.recordId)
    : undefined;
  const selectedCareerFair = careerFairPanelId && careerFairPanelId !== 'new'
    ? state?.careerFairs.find(fair => fair.id === careerFairPanelId)
    : undefined;

  if (startupError) return <StartupError message={startupError} />;
  if (!state) return <LoadingScreen />;

  const saveRecord = async (input: DesktopRecordInput) => {
    setBusy('save');
    const result = await window.desktopApi.saveRecord(input);
    if (result.success && result.data) {
      setState(result.data.state);
      setPanel(null);
      setNotice(result.data.duplicate
        ? { type: 'info', text: `已保存；检测到可能重复的记录：${result.data.duplicate.companyName} ${result.data.duplicate.jobTitle}` }
        : { type: 'success', text: '投递记录已保存' });
    } else showError(result.error, '保存记录失败');
    setBusy('');
  };

  const saveQuickUpdate = async (
    record: ApplicationRecord,
    patch: Pick<DesktopRecordInput, 'status'> | Pick<DesktopRecordInput, 'notes'>,
    label: string,
  ) => {
    if (savingRecordId) return;
    setSavingRecordId(record.id);
    setState(current => patchRecord(current, record.id, patch));
    const result = await window.desktopApi.saveRecord({ ...desktopRecordInput(record), ...patch });
    if (result.success && result.data) {
      setState(result.data.state);
      setNotice(localSaveNotice(label, result.data.state));
    } else {
      setState(current => patchRecord(current, record.id, record));
      showError(result.error, `${label}保存失败`);
    }
    setSavingRecordId('');
  };

  const deleteRecord = async (record: ApplicationRecord) => {
    if (!window.confirm(`确定删除“${record.companyName} · ${record.jobTitle}”吗？`)) return;
    setBusy('delete');
    const result = await window.desktopApi.deleteRecord(record.id);
    if (result.success && result.data) {
      setState(result.data);
      setPanel(null);
      setNotice({ type: 'success', text: '投递记录已删除' });
    } else showError(result.error, '删除记录失败');
    setBusy('');
  };

  const toggleFavorite = async (record: ApplicationRecord, favorite: boolean) => {
    if (savingFavoriteRecordId) return;
    setSavingFavoriteRecordId(record.id);
    setState(current => patchFavorite(current, record.id, favorite));
    const result = await window.desktopApi.setRecordFavorite({ recordId: record.id, favorite });
    if (result.success && result.data) {
      setState(result.data);
      setNotice({ type: 'success', text: favorite ? '已加入特别关注' : '已取消特别关注' });
    } else {
      setState(current => patchFavorite(current, record.id, !favorite));
      showError(result.error, '修改特别关注失败');
    }
    setSavingFavoriteRecordId('');
  };

  const saveCareerFair = async (input: DesktopCareerFairInput) => {
    setBusy('save-career-fair');
    const result = await window.desktopApi.saveCareerFair(input);
    if (result.success && result.data) {
      setState(result.data.state);
      setCareerFairPanelId(null);
      setNotice({ type: 'success', text: '招聘会已保存' });
    } else showError(result.error, '保存招聘会失败');
    setBusy('');
  };

  const deleteCareerFair = async (careerFair: CareerFair) => {
    if (!window.confirm(`确定删除招聘会“${careerFair.name}”吗？`)) return;
    setBusy('delete-career-fair');
    const result = await window.desktopApi.deleteCareerFair(careerFair.id);
    if (result.success && result.data) {
      setState(result.data);
      setCareerFairPanelId(null);
      setNotice({ type: 'success', text: '招聘会已删除' });
    } else showError(result.error, '删除招聘会失败');
    setBusy('');
  };

  const importFile = async (kind: 'json' | 'csv') => {
    if (kind === 'json' && !window.confirm('导入 JSON 会替换桌面端当前投递记录，是否继续？')) return;
    setBusy(`import-${kind}`);
    const result = kind === 'json' ? await window.desktopApi.importJson() : await window.desktopApi.importCsv();
    if (result.success && result.data && !result.data.cancelled) {
      setState(result.data.state);
      setPanel(null);
      setNotice({
        type: result.data.warnings.length ? 'info' : 'success',
        text: `已导入 ${result.data.imported} 条记录${result.data.warnings.length ? `；${result.data.warnings.join('；')}` : ''}`,
      });
    } else if (!result.success) showError(result.error, `导入 ${kind.toUpperCase()} 失败`);
    setBusy('');
  };

  const exportFile = async (kind: 'json' | 'csv') => {
    setBusy(`export-${kind}`);
    const result = kind === 'json' ? await window.desktopApi.exportJson() : await window.desktopApi.exportCsv();
    if (result.success && result.data?.filename) {
      setNotice({ type: 'success', text: `已导出：${result.data.filename}` });
    } else if (!result.success) showError(result.error, `导出 ${kind.toUpperCase()} 失败`);
    setBusy('');
  };

  const syncNow = async () => {
    setBusy('sync');
    const result = await window.desktopApi.syncNow();
    if (result.success && result.data) {
      setState(result.data);
      setNotice(syncNotice(result.data));
    } else showError(result.error, '同步失败');
    setBusy('');
  };

  const saveWebDav = async (input: DesktopWebDavInput) => {
    setBusy('webdav-save');
    const result = await window.desktopApi.saveWebDav(input);
    if (result.success && result.data) {
      setState(result.data);
      setSettingsOpen(false);
      setNotice({ type: 'success', text: 'WebDAV 设置已保存' });
    } else showError(result.error, '保存 WebDAV 设置失败');
    setBusy('');
  };

  const testWebDav = async (input: DesktopWebDavInput) => {
    setBusy('webdav-test');
    const result = await window.desktopApi.testWebDav(input);
    if (result.success && result.data) {
      setNotice({ type: 'success', text: result.data.exists ? '连接成功，已找到远端备份' : '连接成功，远端尚无备份' });
    } else showError(result.error, 'WebDAV 连接失败');
    setBusy('');
  };

  const resolveConflict = async (choice: 'local' | 'remote') => {
    setBusy('resolve');
    const result = await window.desktopApi.resolveConflict(choice);
    if (result.success && result.data) {
      setState(result.data);
      setSettingsOpen(false);
      setNotice(syncNotice(result.data));
    } else showError(result.error, '处理同步冲突失败');
    setBusy('');
  };

  const setupMobileSync = async (input: DesktopMobileSyncSetupInput) => {
    setBusy('mobile-setup');
    const result = await window.desktopApi.setupMobileSync(input);
    if (result.success && result.data) {
      setState(result.data);
      setNotice({ type: 'success', text: '手机安全配对已建立，正在上传首份快照' });
    } else showError(result.error, '建立手机配对失败');
    setBusy('');
  };

  const setMobileSyncEnabled = async (enabled: boolean) => {
    setBusy('mobile-toggle');
    const result = await window.desktopApi.setMobileSyncEnabled(enabled);
    if (result.success && result.data) {
      setState(result.data);
      setNotice({ type: 'success', text: enabled ? '手机自动同步已恢复' : '手机自动同步已暂停' });
    } else showError(result.error, '修改手机同步状态失败');
    setBusy('');
  };

  const syncMobileNow = async () => {
    setBusy('mobile-sync');
    const result = await window.desktopApi.syncMobileNow();
    if (result.success && result.data) {
      setState(result.data);
      setNotice({ type: 'success', text: '手机快照已更新' });
    } else showError(result.error, '手机快照同步失败');
    setBusy('');
  };

  const scanMail = async () => {
    setBusy('mail-scan');
    const result = await window.desktopApi.scanMail();
    if (result.success && result.data) {
      setState(result.data);
      setNotice(result.data.mailInbox.status === 'error' || result.data.mailInbox.status === 'unavailable'
        ? { type: 'error', text: result.data.mailInbox.lastError || '招聘邮箱扫描失败' }
        : { type: 'success', text: `邮箱扫描完成，当前 ${result.data.mailInbox.pendingCount} 封待审核` });
    } else showError(result.error, '招聘邮箱扫描失败');
    setBusy('');
  };

  const confirmMailReview = async (input: DesktopMailReviewDecisionInput) => {
    setBusy(`mail-confirm-${input.reviewId}`);
    const result = await window.desktopApi.confirmMailReview(input);
    if (result.success && result.data) {
      setState(result.data);
      setNotice({ type: 'success', text: '邮件已人工确认，对应投递岗位已更新' });
    } else showError(result.error, '确认招聘邮件失败');
    setBusy('');
  };

  const ignoreMailReview = async (reviewId: string) => {
    setBusy(`mail-ignore-${reviewId}`);
    const result = await window.desktopApi.ignoreMailReview(reviewId);
    if (result.success && result.data) {
      setState(result.data);
      setNotice({ type: 'info', text: '该邮件已忽略，投递岗位状态未改变' });
    } else showError(result.error, '忽略招聘邮件失败');
    setBusy('');
  };

  const ignoreMailReviews = async (reviewIds: string[]) => {
    if (!reviewIds.length || !window.confirm(`确定批量忽略选中的 ${reviewIds.length} 封邮件吗？\n此操作不会修改任何投递岗位状态。`)) return;
    setBusy('mail-ignore-batch');
    const result = await window.desktopApi.ignoreMailReviews(reviewIds);
    if (result.success && result.data) {
      setState(result.data);
      setNotice({ type: 'info', text: `已忽略 ${reviewIds.length} 封邮件，投递岗位状态均未改变` });
    } else showError(result.error, '批量忽略招聘邮件失败');
    setBusy('');
  };

  const openExternal = async (url: string) => {
    const result = await window.desktopApi.openExternal(url);
    if (!result.success) showError(result.error, '无法打开职位链接');
  };

  const toggleDesktopReminder = async () => {
    if (busy) return;
    const enabled = !state.desktopReminder.enabled;
    setBusy('desktop-reminder');
    const result = await window.desktopApi.setDesktopReminderEnabled(enabled);
    if (result.success && result.data) {
      setState(result.data);
      setNotice({
        type: 'success',
        text: enabled
          ? '桌面弹窗提醒已开启；手机提醒保持原设置'
          : '桌面弹窗提醒已关闭；近期安排和手机提醒不受影响',
      });
    } else showError(result.error, `${enabled ? '开启' : '关闭'}桌面提醒失败`);
    setBusy('');
  };

  const setScheduleCompleted = async (item: UpcomingRecruitmentSchedule, completed: boolean) => {
    if (busy) return;
    const record = state.records.find(current => current.id === item.recordId);
    if (!record) {
      showError(undefined, '对应的投递岗位不存在');
      return;
    }
    setBusy('schedule-completion');
    const result = await window.desktopApi.saveRecord({
      ...desktopRecordInput(record),
      recruitmentSchedule: setRecruitmentScheduleCompleted(
        record.recruitmentSchedule,
        item.kind,
        completed ? new Date().toISOString() : undefined,
      ),
    });
    if (result.success && result.data) {
      setState(result.data.state);
      setNotice({
        type: 'success',
        text: completed
          ? `${item.companyName} · ${item.label}已完成，桌面和手机后续提醒已取消`
          : `${item.companyName} · ${item.label}已恢复为待处理`,
      });
    } else showError(result.error, `${completed ? '标记' : '撤销'}完成失败`);
    setBusy('');
  };

  function showError(error: string | undefined, fallback: string): void {
    setNotice({ type: 'error', text: error || fallback });
  }

  const RecordList = viewMode === 'companies' ? CompanyRecordsView : RecordsTable;
  const selectStatus = (nextStatus: StatusFilter) => {
    setSection('applications');
    setStatus(nextStatus);
    if (nextStatus === '已投递汇总') setSort('stage');
  };

  return (
    <div className="desktop-shell">
      <AppHeader
        sync={state.localSync}
        reminder={state.desktopReminder}
        reminderBusy={busy === 'desktop-reminder'}
        upcomingCount={upcomingCount}
        syncing={busy === 'sync'}
        onToggleReminder={() => void toggleDesktopReminder()}
        onUpcoming={() => setUpcomingOpen(true)}
        onSync={() => void syncNow()}
        onMobile={() => setMobileSyncOpen(true)}
        onSettings={() => setSettingsOpen(true)}
      />
      <div className="workspace">
        <PipelineRail
          total={state.records.length}
          active={activeApplicationCount(state.records)}
          favoriteCount={state.favoriteRecordIds.length}
          favoritesSelected={section === 'favorites'}
          pendingMailCount={state.mailInbox.pendingCount}
          mailSelected={section === 'mail-inbox'}
          careerFairCount={state.careerFairs.length}
          upcomingCareerFairCount={upcomingCareerFairCount(state.careerFairs)}
          careerFairsSelected={section === 'career-fairs'}
          counts={pipelineCounts(state.records)}
          selected={status}
          onSelectFavorites={() => { setSection('favorites'); setStatus('全部'); setPanel(null); }}
          onSelectMail={() => { setSection('mail-inbox'); setPanel(null); }}
          onSelectCareerFairs={() => { setSection('career-fairs'); setPanel(null); }}
          onSelect={selectStatus}
        />
        {section === 'mail-inbox' ? (
          <MailInboxView
            inbox={state.mailInbox}
            records={state.records}
            busy={busy.startsWith('mail-')}
            onScan={() => void scanMail()}
            onConfirm={input => void confirmMailReview(input)}
            onIgnore={reviewId => void ignoreMailReview(reviewId)}
            onIgnoreMany={reviewIds => void ignoreMailReviews(reviewIds)}
            onOpenUrl={url => void openExternal(url)}
          />
        ) : section === 'career-fairs' ? (
          <CareerFairsView
            careerFairs={state.careerFairs}
            busy={Boolean(busy)}
            onNew={() => setCareerFairPanelId('new')}
            onEdit={careerFair => setCareerFairPanelId(careerFair.id)}
            onDelete={careerFair => void deleteCareerFair(careerFair)}
            onOpenUrl={url => void openExternal(url)}
          />
        ) : <main className="records-workbench">
          <div className="workbench-heading">
            <div><p>{workbenchKicker(status, section)}</p><h1>{workbenchTitle(status, section)}</h1><span>共 {visibleRecords.length} 条；状态和备注可直接修改，点击其余区域查看详情。</span></div>
            <div className="workbench-actions">
              <details className="data-menu">
                <summary className="square-button" aria-label="导入导出"><MoreIcon /></summary>
                <div>
                  <button type="button" onClick={() => void importFile('json')}>导入 JSON（覆盖）</button>
                  <button type="button" onClick={() => void exportFile('json')}>导出 JSON</button>
                  <button type="button" onClick={() => void importFile('csv')}>导入 CSV（合并）</button>
                  <button type="button" onClick={() => void exportFile('csv')}>导出 CSV</button>
                </div>
              </details>
              <button type="button" className="button-primary new-record-button" onClick={() => setPanel({ mode: 'new' })}>＋ 新建记录</button>
            </div>
          </div>
          {state.sync.status === 'conflict' && (
            <button type="button" className="inline-conflict" onClick={() => setSettingsOpen(true)}>
              <strong>同步已暂停</strong><span>桌面端和远端记录都有变化，点击选择保留版本。</span>
            </button>
          )}
          <div className="records-toolbar">
            <label className="search-field"><SearchIcon /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索公司、岗位、地点、备注…" aria-label="搜索投递记录" /></label>
            <div className="records-toolbar-actions">
              <div className="view-switch" role="group" aria-label="投递记录查看方式">
                <button type="button" className={viewMode === 'records' ? 'is-active' : ''} aria-pressed={viewMode === 'records'} onClick={() => setViewMode('records')}>逐条查看</button>
                <button type="button" className={viewMode === 'companies' ? 'is-active' : ''} aria-pressed={viewMode === 'companies'} onClick={() => setViewMode('companies')}>按公司查看</button>
              </div>
              <label className="sort-field"><span>排序</span><select value={sort} onChange={event => setSort(event.target.value as RecordSort)}><option value="recent">最近投递</option><option value="oldest">最早投递</option><option value="company">公司名称</option><option value="stage">求职阶段（接近录用优先）</option><option value="status">状态名称</option></select></label>
            </div>
          </div>
          <RecordList
            records={visibleRecords}
            selectedId={selectedRecord?.id}
            busy={Boolean(busy)}
            savingRecordId={savingRecordId}
            favoriteRecordIds={favoriteRecordIds}
            savingFavoriteRecordId={savingFavoriteRecordId}
            onSelect={record => setPanel({ mode: 'view', recordId: record.id })}
            onToggleFavorite={(record, favorite) => void toggleFavorite(record, favorite)}
            onOpenUrl={url => void openExternal(url)}
            onStatusChange={(record, nextStatus: ApplicationRecordStatus) => {
              if (nextStatus !== record.status) void saveQuickUpdate(record, { status: nextStatus }, '投递状态');
            }}
            onSaveNotes={(record, notes) => void saveQuickUpdate(record, { notes }, '备注')}
            onEditSchedule={record => setPanel({ mode: 'edit', recordId: record.id })}
          />
        </main>}
      </div>
      {panel && (
        <RecordPanel
          key={panel.mode === 'new' ? 'new' : `${panel.mode}-${selectedRecord?.id}`}
          mode={panel.mode}
          record={selectedRecord}
          busy={Boolean(busy)}
          onClose={() => setPanel(null)}
          onEdit={() => selectedRecord && setPanel({ mode: 'edit', recordId: selectedRecord.id })}
          onDelete={record => void deleteRecord(record)}
          onOpenUrl={url => void openExternal(url)}
          onSave={input => void saveRecord(input)}
        />
      )}
      {settingsOpen && (
        <WebDavPanel
          current={state.webdav}
          sync={state.sync}
          busy={Boolean(busy)}
          onClose={() => setSettingsOpen(false)}
          onSave={input => void saveWebDav(input)}
          onTest={input => void testWebDav(input)}
          onResolve={choice => void resolveConflict(choice)}
        />
      )}
      {mobileSyncOpen && (
        <MobileSyncPanel
          current={state.mobileSync}
          busy={busy.startsWith('mobile-')}
          onClose={() => setMobileSyncOpen(false)}
          onSetup={input => void setupMobileSync(input)}
          onSetEnabled={enabled => void setMobileSyncEnabled(enabled)}
          onSync={() => void syncMobileNow()}
        />
      )}
      {upcomingOpen && (
        <UpcomingSchedulePanel
          records={state.records}
          reminder={state.desktopReminder}
          reminderBusy={busy === 'desktop-reminder'}
          completionBusy={busy === 'schedule-completion'}
          onClose={() => setUpcomingOpen(false)}
          onToggleReminder={() => void toggleDesktopReminder()}
          onOpenRecord={recordId => {
            setUpcomingOpen(false);
            setPanel({ mode: 'view', recordId });
          }}
          onOpenUrl={url => void openExternal(url)}
          onSetCompleted={(item, completed) => void setScheduleCompleted(item, completed)}
        />
      )}
      {careerFairPanelId && (
        <CareerFairPanel
          key={careerFairPanelId}
          careerFair={selectedCareerFair}
          busy={busy === 'save-career-fair'}
          onClose={() => setCareerFairPanelId(null)}
          onSave={input => void saveCareerFair(input)}
        />
      )}
      {notice && <div className={`toast toast-${notice.type}`} role="status"><span>{notice.text}</span><button type="button" onClick={() => setNotice(null)} aria-label="关闭提示">×</button></div>}
    </div>
  );
}

function workbenchTitle(status: StatusFilter, section: WorkspaceSection): string {
  if (section === 'favorites') return '特别关注';
  if (status === '全部') return '全部投递记录';
  if (status === '已投递汇总') return '已投递汇总';
  return status;
}

function workbenchKicker(status: StatusFilter, section: WorkspaceSection): string {
  if (section === 'favorites') return 'RECORDS / FAVORITES';
  if (status === '全部') return 'RECORDS / ALL';
  if (status === '已投递汇总') return 'RECORDS / SUBMITTED';
  return `RECORDS / ${status}`;
}

function syncNotice(state: DesktopState): Notice {
  if (state.localSync.status === 'synced') return { type: 'success', text: '投递记录已与 Edge 扩展同步' };
  if (state.localSync.status === 'error') return { type: 'error', text: state.localSync.lastError || '本机同步失败' };
  if (state.sync.status === 'synced') return { type: 'success', text: '投递记录已与 WebDAV 同步' };
  if (state.sync.status === 'conflict') return { type: 'info', text: state.sync.lastError || '同步存在冲突' };
  if (state.sync.status === 'error') return { type: 'error', text: state.sync.lastError || '同步失败' };
  return { type: 'info', text: '当前仅保存在本机' };
}

function localSaveNotice(label: string, state: DesktopState): NonNullable<Notice> {
  if (state.localSync.status === 'error') {
    return {
      type: 'error',
      text: `${label}已保存到桌面端，但 Edge 同步失败：${state.localSync.lastError || '本机共享文件写入失败'}`,
    };
  }
  return { type: 'success', text: `${label}已保存，并已写入 Edge 同步区` };
}

function patchRecord(
  state: DesktopState | null,
  recordId: string,
  patch: Partial<ApplicationRecord>,
): DesktopState | null {
  if (!state) return state;
  return {
    ...state,
    records: state.records.map(record => record.id === recordId ? { ...record, ...patch } : record),
  };
}

function patchFavorite(
  state: DesktopState | null,
  recordId: string,
  favorite: boolean,
): DesktopState | null {
  if (!state) return state;
  const favoriteRecordIds = new Set(state.favoriteRecordIds);
  if (favorite) favoriteRecordIds.add(recordId);
  else favoriteRecordIds.delete(recordId);
  return { ...state, favoriteRecordIds: [...favoriteRecordIds] };
}

function LoadingScreen() {
  return <main className="startup-screen"><div className="brand-mark large" aria-hidden="true"><span /><span /><span /></div><p>正在打开投递台账…</p></main>;
}

function StartupError({ message }: { message: string }) {
  return <main className="startup-screen startup-error"><strong>无法打开本地数据</strong><p>{message}</p><button type="button" className="button-primary" onClick={() => window.location.reload()}>重试</button></main>;
}

export default App;
