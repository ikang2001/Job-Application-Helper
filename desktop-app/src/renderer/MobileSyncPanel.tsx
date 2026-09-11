import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type {
  DesktopMobilePairingInfo,
  DesktopMobileSyncSetupInput,
  DesktopMobileSyncState,
} from '../shared/contracts.ts';
import { CloseIcon } from './Icons.tsx';

interface MobileSyncPanelProps {
  current: DesktopMobileSyncState;
  busy: boolean;
  onClose(): void;
  onSetup(input: DesktopMobileSyncSetupInput): void;
  onSetEnabled(enabled: boolean): void;
  onSync(): void;
}

export function MobileSyncPanel(props: MobileSyncPanelProps) {
  const [serverUrl, setServerUrl] = useState(props.current.serverUrl);
  const [setupToken, setSetupToken] = useState('');
  const [showSetup, setShowSetup] = useState(!props.current.configured);
  const [pairing, setPairing] = useState<DesktopMobilePairingInfo>();
  const [pairingError, setPairingError] = useState('');
  const [qrCode, setQrCode] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!props.current.configured || showSetup) return;
    let active = true;
    void window.desktopApi.getMobilePairing().then(async result => {
      if (!active) return;
      if (!result.success || !result.data) {
        setPairingError(result.error || '无法读取手机配对信息');
        return;
      }
      setPairing(result.data);
      setPairingError('');
      try {
        const image = await QRCode.toDataURL(result.data.pairingUrl, {
          errorCorrectionLevel: 'M',
          margin: 1,
          width: 236,
          color: { dark: '#183c3a', light: '#ffffff' },
        });
        if (active) setQrCode(image);
      } catch {
        if (active) setPairingError('二维码生成失败，请复制配对链接');
      }
    });
    return () => { active = false; };
  }, [props.current.configured, props.current.serverUrl, showSetup]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    props.onSetup({ serverUrl, setupToken });
  };

  const copyPairingLink = async () => {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing.pairingUrl);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = pairing.pairingUrl;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <div className="panel-backdrop" onMouseDown={event => event.target === event.currentTarget && props.onClose()}>
      <aside className="settings-panel mobile-sync-panel" role="dialog" aria-modal="true" aria-label="手机只读查看">
        <header className="panel-header">
          <div><p>MOBILE VIEW</p><h2>手机只读查看</h2></div>
          <button type="button" className="square-button" onClick={props.onClose} aria-label="关闭"><CloseIcon /></button>
        </header>

        {showSetup ? (
          <form onSubmit={submit}>
            <div className="settings-intro mobile-intro">
              <span className="phone-glyph" aria-hidden="true"><i /></span>
              <div><strong>独立加密快照，不改动现有数据</strong><p>电脑保存成功后再后台上传。手机只能查看；同步失败不会阻塞桌面保存，也不会删除投递或招聘会记录。</p></div>
            </div>
            <div className="settings-form">
              <label><span>手机同步服务地址</span><input type="url" value={serverUrl} onChange={event => setServerUrl(event.target.value)} placeholder="https://mobile.example.com" required /></label>
              <label>
                <span>服务设置码</span>
                <input type="password" value={setupToken} onChange={event => setSetupToken(event.target.value)} autoComplete="off" required />
                <small>设置码只用于创建本次配对，不会进入手机快照。</small>
              </label>
            </div>
            <footer className="panel-actions settings-actions">
              {props.current.configured && <button type="button" className="button-secondary" onClick={() => setShowSetup(false)} disabled={props.busy}>取消更换</button>}
              <button type="submit" className="button-primary" disabled={props.busy}>{props.busy ? '正在建立…' : '建立安全配对'}</button>
            </footer>
          </form>
        ) : (
          <div className="mobile-paired-view">
            <div className={`mobile-sync-summary status-${props.current.status}`}>
              <span className="sync-indicator" />
              <div><strong>{mobileStatusLabel(props.current)}</strong><small>{mobileStatusDetail(props.current)}</small></div>
            </div>
            <div className="mobile-pairing-card">
              <div className="mobile-qr">
                {qrCode ? <img src={qrCode} alt="手机配对二维码" /> : <span>{pairingError || '正在生成二维码…'}</span>}
              </div>
              <div className="mobile-pairing-copy">
                <p>用手机相机扫描二维码，打开后选择“添加到主屏幕”。电脑关机后仍会显示云端最后一次成功快照。</p>
                <code>{pairing?.deviceId || '—'}</code>
                <button type="button" className="button-secondary" onClick={() => void copyPairingLink()} disabled={!pairing}>{copied ? '已复制' : '复制配对链接'}</button>
              </div>
            </div>
            <div className="privacy-list">
              <span>手机快照包含：公司、岗位、状态、安排、备注、链接、招聘会</span>
              <span>不会包含：简历、身份证、API Key、邮箱密码、邮件正文</span>
            </div>
            <div className="remote-path"><span>同步服务</span><code>{props.current.serverUrl}</code></div>
            <footer className="panel-actions settings-actions mobile-actions">
              <button type="button" className="button-secondary" onClick={() => setShowSetup(true)} disabled={props.busy}>更换服务</button>
              <button type="button" className="button-secondary" onClick={() => props.onSetEnabled(!props.current.enabled)} disabled={props.busy}>{props.current.enabled ? '暂停自动同步' : '恢复自动同步'}</button>
              <button type="button" className="button-primary" onClick={props.onSync} disabled={props.busy || !props.current.enabled}>{props.busy ? '同步中…' : '立即同步'}</button>
            </footer>
          </div>
        )}
      </aside>
    </div>
  );
}

function mobileStatusLabel(state: DesktopMobileSyncState): string {
  if (!state.enabled) return '手机同步已暂停';
  if (state.status === 'syncing') return '正在更新手机快照';
  if (state.status === 'synced') return '手机快照已更新';
  if (state.status === 'error') return '手机同步失败';
  return '等待首次同步';
}

function mobileStatusDetail(state: DesktopMobileSyncState): string {
  if (state.lastError) return state.lastError;
  if (!state.lastSyncedAt) return '尚未上传快照';
  const date = new Date(state.lastSyncedAt);
  return Number.isNaN(date.getTime())
    ? state.lastSyncedAt
    : `上次 ${date.toLocaleString('zh-CN', { hour12: false })}`;
}
