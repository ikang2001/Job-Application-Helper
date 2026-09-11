import React, { useState } from 'react';
import type {
  DesktopSyncState,
  DesktopWebDavInput,
  DesktopWebDavState,
} from '../shared/contracts.ts';
import { CloseIcon } from './Icons.tsx';

interface WebDavPanelProps {
  current: DesktopWebDavState;
  sync: DesktopSyncState;
  busy: boolean;
  onClose(): void;
  onSave(input: DesktopWebDavInput): void;
  onTest(input: DesktopWebDavInput): void;
  onResolve(choice: 'local' | 'remote'): void;
}

export function WebDavPanel(props: WebDavPanelProps) {
  const [form, setForm] = useState<DesktopWebDavInput>({
    enabled: props.current.enabled,
    serverUrl: props.current.serverUrl,
    username: props.current.username,
    password: '',
  });
  const update = <K extends keyof DesktopWebDavInput>(key: K, value: DesktopWebDavInput[K]) => {
    setForm(current => ({ ...current, [key]: value }));
  };
  return (
    <div className="panel-backdrop" onMouseDown={event => event.target === event.currentTarget && props.onClose()}>
      <aside className="settings-panel" role="dialog" aria-modal="true" aria-label="WebDAV 同步设置">
        <header className="panel-header">
          <div><p>DATA BRIDGE</p><h2>同步设置</h2></div>
          <button type="button" className="square-button" onClick={props.onClose} aria-label="关闭"><CloseIcon /></button>
        </header>
        <div className="settings-intro">
          <span className="bridge-glyph" aria-hidden="true"><i /><i /><i /></span>
          <div><strong>WebDAV 是可选的异地备份</strong><p>本机 Edge 扩展与桌面端已经自动同步投递记录；配置 WebDAV 后可再增加一份远端备份。</p></div>
        </div>
        <div className="settings-form">
          <label><span>WebDAV 服务器地址</span><input type="url" value={form.serverUrl} onChange={event => update('serverUrl', event.target.value)} placeholder="https://dav.example.com/" /></label>
          <label><span>用户名</span><input value={form.username} onChange={event => update('username', event.target.value)} autoComplete="username" /></label>
          <label>
            <span>密码或应用密码</span>
            <input type="password" value={form.password} onChange={event => update('password', event.target.value)} autoComplete="current-password" placeholder={props.current.passwordConfigured ? '已安全保存；留空表示不修改' : '请输入密码'} />
            <small>密码使用 Windows 系统加密后保存在本机，不会显示在页面中。</small>
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={form.enabled} onChange={event => update('enabled', event.target.checked)} />
            <span><strong>保存记录后自动同步</strong><small>失败不会回滚本地保存，可稍后手动重试。</small></span>
          </label>
        </div>
        {props.sync.status === 'conflict' && (
          <div className="conflict-card" role="alert">
            <strong>需要选择保留版本</strong>
            <p>本机 {props.sync.conflict?.localCount ?? '—'} 条，远端 {props.sync.conflict?.remoteCount ?? '—'} 条。选择本机只会覆盖远端投递记录，其他扩展数据保持不变。</p>
            <div><button type="button" className="button-secondary" onClick={() => props.onResolve('remote')} disabled={props.busy}>保留远端</button><button type="button" className="button-danger" onClick={() => props.onResolve('local')} disabled={props.busy}>保留本机</button></div>
          </div>
        )}
        <div className="remote-path"><span>远端文件</span><code>job-application-helper/job-application-helper.json</code></div>
        <footer className="panel-actions settings-actions">
          <button type="button" className="button-secondary" onClick={() => props.onTest(form)} disabled={props.busy}>测试连接</button>
          <button type="button" className="button-primary" onClick={() => props.onSave(form)} disabled={props.busy}>{props.busy ? '处理中…' : '保存设置'}</button>
        </footer>
      </aside>
    </div>
  );
}
