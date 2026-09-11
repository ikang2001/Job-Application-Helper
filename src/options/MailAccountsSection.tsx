import React, { useEffect, useMemo, useState } from 'react';
import { MessageService } from '../shared/message.ts';
import type { ApplicationRecord, Message } from '../shared/types.ts';
import type { MailAccount } from '../services/mail/accounts.ts';
import type { PendingMailReview } from '../services/mail/types.ts';

interface MailAccountsSectionProps {
  initialAccounts?: MailAccount[];
  initialReviews?: PendingMailReview[];
  initialRecords?: ApplicationRecord[];
}

type Notice = { type: 'success' | 'error' | 'info'; text: string } | null;

const IMAP_PRESETS = {
  qq: { host: 'imap.qq.com', port: 993 },
  '163': { host: 'imap.163.com', port: 993 },
  '126': { host: 'imap.126.com', port: 993 },
  imap: { host: '', port: 993 },
} as const;

function emptyAccount(): MailAccount {
  return {
    id: '', provider: 'gmail', emailAddress: '', displayName: '', enabled: true,
    oauthClientId: '', connectionState: 'disconnected',
  };
}

export function MailAccountsSection({
  initialAccounts = [],
  initialReviews = [],
  initialRecords = [],
}: MailAccountsSectionProps) {
  const [accounts, setAccounts] = useState(initialAccounts);
  const [reviews, setReviews] = useState(initialReviews);
  const [records, setRecords] = useState(initialRecords);
  const [draft, setDraft] = useState<MailAccount>(emptyAccount);
  const [credential, setCredential] = useState('');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [reviewTargets, setReviewTargets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const load = async () => {
    const [accountResponse, reviewResponse, recordResponse] = await Promise.all([
      MessageService.sendMessage<MailAccount[]>({ type: 'GET_MAIL_ACCOUNTS' }),
      MessageService.sendMessage<PendingMailReview[]>({ type: 'GET_PENDING_MAIL_REVIEWS' }),
      MessageService.sendMessage<ApplicationRecord[]>({ type: 'GET_APPLICATION_RECORDS' }),
    ]);
    if (accountResponse.success) setAccounts(accountResponse.data ?? []);
    if (reviewResponse.success) setReviews(reviewResponse.data ?? []);
    if (recordResponse.success) setRecords(recordResponse.data ?? []);
    const error = accountResponse.error || reviewResponse.error || recordResponse.error;
    if (error) setNotice({ type: 'error', text: error });
  };

  useEffect(() => {
    if (initialAccounts.length || initialReviews.length || initialRecords.length) return;
    void load();
  }, [initialAccounts.length, initialRecords.length, initialReviews.length]);

  const connectedCount = useMemo(
    () => accounts.filter(account => account.connectionState === 'connected').length,
    [accounts],
  );

  const updateDraft = <K extends keyof MailAccount>(key: K, value: MailAccount[K]) => {
    setDraft(current => ({ ...current, [key]: value }));
  };

  const handleProviderChange = (provider: MailAccount['provider']) => {
    setDraft(current => provider === 'imap'
      ? {
          ...current,
          provider,
          oauthClientId: undefined,
          imap: { provider: 'qq', ...IMAP_PRESETS.qq, secure: true, username: current.emailAddress },
        }
      : { ...current, provider, imap: undefined, oauthClientId: current.oauthClientId ?? '' });
  };

  const handleImapPresetChange = (provider: keyof typeof IMAP_PRESETS) => {
    const preset = IMAP_PRESETS[provider];
    setDraft(current => ({
      ...current,
      imap: {
        provider,
        host: preset.host,
        port: preset.port,
        secure: true,
        username: current.imap?.username || current.emailAddress,
      },
    }));
  };

  const saveAccount = async () => {
    setBusy('save');
    setNotice(null);
    const response = await MessageService.sendMessage<MailAccount>({
      type: 'UPSERT_MAIL_ACCOUNT', payload: { account: draft, credential: credential || undefined },
    });
    if (response.success && response.data) {
      setDraft(emptyAccount());
      setCredential('');
      setNotice({ type: 'success', text: '邮箱账号已保存；请继续连接并授权。' });
      await load();
    } else {
      setNotice({ type: 'error', text: response.error || '保存邮箱失败' });
    }
    setBusy(null);
  };

  const runAccountAction = async (
    account: MailAccount,
    action: Extract<Message['type'], 'CONNECT_MAIL_ACCOUNT' | 'DISCONNECT_MAIL_ACCOUNT' | 'TEST_MAIL_ACCOUNT' | 'DELETE_MAIL_ACCOUNT'>,
  ) => {
    setBusy(`${action}:${account.id}`);
    setNotice(null);
    const payload = action === 'CONNECT_MAIL_ACCOUNT'
      ? { accountId: account.id, credential: credentials[account.id] || undefined }
      : { accountId: account.id };
    const response = await MessageService.sendMessage({ type: action, payload } as Message);
    setNotice(response.success
      ? { type: 'success', text: actionResultText(action) }
      : { type: 'error', text: response.error || '邮箱操作失败' });
    if (response.success) {
      setCredentials(current => ({ ...current, [account.id]: '' }));
      await load();
    }
    setBusy(null);
  };

  const syncMail = async (accountId?: string) => {
    setBusy(`sync:${accountId || 'all'}`);
    setNotice({ type: 'info', text: '正在读取新邮件，请保持浏览器打开…' });
    const response = await MessageService.sendMessage<Array<{
      inspectedHeaders: number;
      autoUpdated: number;
      pendingReviews: number;
      error?: string;
    }>>({ type: 'SYNC_MAIL', payload: accountId ? { accountId } : null });
    if (!response.success) {
      setNotice({ type: 'error', text: response.error || '扫描失败' });
    } else {
      const results = response.data ?? [];
      const inspected = results.reduce((sum, result) => sum + result.inspectedHeaders, 0);
      const updated = results.reduce((sum, result) => sum + result.autoUpdated, 0);
      const pending = results.reduce((sum, result) => sum + result.pendingReviews, 0);
      const failures = results.filter(result => result.error).length;
      setNotice({
        type: failures ? 'error' : 'success',
        text: `已检查 ${inspected} 封候选邮件，自动更新 ${updated} 条，待确认 ${pending} 条${failures ? `，${failures} 个账号失败` : ''}。`,
      });
      await load();
    }
    setBusy(null);
  };

  const decideReview = async (review: PendingMailReview, action: 'confirm' | 'ignore') => {
    setBusy(`${action}:${review.id}`);
    const response = action === 'confirm'
      ? await MessageService.sendMessage({
          type: 'CONFIRM_MAIL_REVIEW',
          payload: { reviewId: review.id, recordId: reviewTargets[review.id] || review.recordId },
        })
      : await MessageService.sendMessage({ type: 'IGNORE_MAIL_REVIEW', payload: { reviewId: review.id } });
    setNotice(response.success
      ? { type: 'success', text: action === 'confirm' ? '邮件已关联到投递记录' : '邮件已忽略' }
      : { type: 'error', text: response.error || '处理待确认邮件失败' });
    if (response.success) await load();
    setBusy(null);
  };

  return (
    <section className="mail-control-center">
      <header className="mail-control-header">
        <div>
          <p className="mail-eyebrow">MAIL SIGNALS</p>
          <h2>招聘邮件监控</h2>
          <p>只读识别申请确认、测评、面试、Offer 和拒信；低置信度必须由你确认。</p>
        </div>
        <div className="mail-control-summary" aria-label="邮箱监控摘要">
          <strong>{connectedCount}/{accounts.length}</strong><span>已连接</span>
          <strong>{reviews.length}</strong><span>待确认</span>
        </div>
      </header>

      {notice && <div className={`mail-notice ${notice.type}`} role="status">{notice.text}</div>}

      <section className="mail-setup-card">
        <h3>添加邮箱</h3>
        <div className="mail-form-grid">
          <label><span>类型</span><select value={draft.provider} onChange={event => handleProviderChange(event.target.value as MailAccount['provider'])}>
            <option value="gmail">Gmail</option><option value="outlook">Outlook</option><option value="imap">QQ / 163 / IMAP</option>
          </select></label>
          <label><span>邮箱地址</span><input type="email" value={draft.emailAddress} onChange={event => {
            const emailAddress = event.target.value;
            setDraft(current => ({ ...current, emailAddress, imap: current.imap ? { ...current.imap, username: current.imap.username || emailAddress } : undefined }));
          }} placeholder="name@example.com" /></label>
          <label><span>显示名称</span><input value={draft.displayName ?? ''} onChange={event => updateDraft('displayName', event.target.value)} placeholder="例如：秋招邮箱" /></label>
          {draft.provider !== 'imap' ? (
            <label><span>OAuth Client ID</span><input value={draft.oauthClientId ?? ''} onChange={event => updateDraft('oauthClientId', event.target.value)} placeholder="在 Google/Microsoft 开发者后台创建" /></label>
          ) : (
            <>
              <label><span>邮箱服务</span><select value={draft.imap?.provider ?? 'qq'} onChange={event => handleImapPresetChange(event.target.value as keyof typeof IMAP_PRESETS)}>
                <option value="qq">QQ</option><option value="163">163</option><option value="126">126</option><option value="imap">其他 IMAP</option>
              </select></label>
              <label><span>IMAP TLS 主机</span><input value={draft.imap?.host ?? ''} onChange={event => setDraft(current => ({ ...current, imap: current.imap ? { ...current.imap, host: event.target.value } : current.imap }))} placeholder="imap.example.com" /></label>
              <label><span>用户名</span><input value={draft.imap?.username ?? ''} onChange={event => setDraft(current => ({ ...current, imap: current.imap ? { ...current.imap, username: event.target.value } : current.imap }))} /></label>
              <label><span>授权码 / App Password</span><input type="password" value={credential} onChange={event => setCredential(event.target.value)} autoComplete="new-password" /></label>
            </>
          )}
        </div>
        <label className="mail-enable-toggle"><input type="checkbox" checked={draft.enabled} onChange={event => updateDraft('enabled', event.target.checked)} />启用自动扫描</label>
        <button type="button" className="btn btn-primary" onClick={() => void saveAccount()} disabled={busy !== null}>保存账号</button>
      </section>

      <div className="mail-section-heading"><h3>已配置邮箱</h3><button type="button" className="btn btn-secondary" onClick={() => void syncMail()} disabled={busy !== null || accounts.length === 0}>立即检查全部</button></div>
      <div className="mail-account-list">
        {accounts.length === 0 ? <p className="mail-empty">尚未配置邮箱。Gmail/Outlook 使用 OAuth，QQ/163 使用本地邮箱组件。</p> : accounts.map(account => (
          <article key={account.id} className={`mail-account-card state-${account.connectionState ?? 'disconnected'}`}>
            <div className="mail-account-main"><strong>{account.displayName || account.emailAddress}</strong><span>{account.emailAddress}</span><small>{providerLabel(account.provider)} · {connectionLabel(account.connectionState)}</small>{account.lastError && <p>{account.lastError}</p>}</div>
            {account.provider === 'imap' && <input className="mail-inline-secret" type="password" value={credentials[account.id] ?? ''} onChange={event => setCredentials(current => ({ ...current, [account.id]: event.target.value }))} placeholder="连接时输入授权码" autoComplete="new-password" />}
            <div className="mail-account-actions">
              <button type="button" onClick={() => void runAccountAction(account, 'CONNECT_MAIL_ACCOUNT')} disabled={busy !== null}>连接</button>
              <button type="button" onClick={() => void runAccountAction(account, 'TEST_MAIL_ACCOUNT')} disabled={busy !== null}>测试</button>
              <button type="button" onClick={() => void syncMail(account.id)} disabled={busy !== null}>检查</button>
              <button type="button" onClick={() => void runAccountAction(account, 'DISCONNECT_MAIL_ACCOUNT')} disabled={busy !== null}>断开</button>
              <button type="button" className="danger" onClick={() => void runAccountAction(account, 'DELETE_MAIL_ACCOUNT')} disabled={busy !== null}>删除</button>
            </div>
          </article>
        ))}
      </div>

      <div className="mail-section-heading"><h3>待确认邮件</h3><span>{reviews.length} 条</span></div>
      <div className="mail-review-list">
        {reviews.length === 0 ? <p className="mail-empty">暂无待确认项。高置信度事件会写入时间线，低置信度事件会出现在这里。</p> : reviews.map(review => (
          <article key={review.id} className="mail-review-card">
            <div><strong>{review.email.subject || '无主题邮件'}</strong><p>{review.extracted.summary || review.email.text || '未提取摘要'}</p><small>{review.email.from.address} · 匹配置信度 {Math.round(review.confidences.matchConfidence * 100)}%</small></div>
            <select value={reviewTargets[review.id] ?? review.recordId ?? ''} onChange={event => setReviewTargets(current => ({ ...current, [review.id]: event.target.value }))} aria-label="关联投递记录">
              <option value="">选择投递记录</option>{records.map(record => <option key={record.id} value={record.id}>{record.companyName} · {record.jobTitle || '未命名岗位'}</option>)}
            </select>
            <div className="mail-review-actions"><button type="button" className="btn btn-primary" onClick={() => void decideReview(review, 'confirm')} disabled={busy !== null}>确认关联</button><button type="button" className="btn btn-secondary" onClick={() => void decideReview(review, 'ignore')} disabled={busy !== null}>忽略</button></div>
          </article>
        ))}
      </div>
    </section>
  );
}

function providerLabel(provider: MailAccount['provider']): string {
  return provider === 'gmail' ? 'Gmail' : provider === 'outlook' ? 'Outlook' : 'IMAP';
}

function connectionLabel(state: MailAccount['connectionState']): string {
  return ({ connected: '已连接', disconnected: '未连接', 'needs-authorization': '需要重新授权', error: '连接异常' })[state ?? 'disconnected'];
}

function actionResultText(action: string): string {
  return ({ CONNECT_MAIL_ACCOUNT: '邮箱已连接', DISCONNECT_MAIL_ACCOUNT: '邮箱已断开', TEST_MAIL_ACCOUNT: '连接测试成功', DELETE_MAIL_ACCOUNT: '邮箱已删除' } as Record<string, string>)[action] ?? '操作完成';
}

export default MailAccountsSection;
