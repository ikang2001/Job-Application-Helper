import React, { useState } from 'react';
import {
  CAREER_FAIR_MODES,
  CAREER_FAIR_STATUSES,
  type CareerFair,
  type DesktopCareerFairInput,
} from '../shared/contracts.ts';
import { careerFairInput } from '../domain/careerFairs.ts';
import { CloseIcon } from './Icons.tsx';

interface CareerFairPanelProps {
  careerFair?: CareerFair;
  busy: boolean;
  onClose(): void;
  onSave(input: DesktopCareerFairInput): void;
}

export function CareerFairPanel({ careerFair, busy, onClose, onSave }: CareerFairPanelProps) {
  const [form, setForm] = useState<DesktopCareerFairInput>(() => (
    careerFair ? careerFairInput(careerFair) : emptyCareerFairInput()
  ));
  const update = <K extends keyof DesktopCareerFairInput>(key: K, value: DesktopCareerFairInput[K]) => {
    setForm(current => ({ ...current, [key]: value }));
  };
  return (
    <div className="panel-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <aside className="record-panel" role="dialog" aria-modal="true" aria-label={careerFair ? '编辑招聘会' : '新建招聘会'}>
        <header className="panel-header">
          <div><p>CAREER FAIR</p><h2>{careerFair ? '编辑招聘会' : '新建招聘会'}</h2></div>
          <button type="button" className="square-button" onClick={onClose} aria-label="关闭"><CloseIcon /></button>
        </header>
        <form className="record-form career-fair-form" onSubmit={(event) => { event.preventDefault(); onSave(form); }}>
          <div className="form-grid">
            <label className="form-span-two"><span>招聘会名称</span><input required aria-label="招聘会名称" value={form.name} onChange={event => update('name', event.target.value)} /></label>
            <label><span>参加状态</span><select aria-label="招聘会参加状态" value={form.status} onChange={event => update('status', event.target.value as DesktopCareerFairInput['status'])}>{CAREER_FAIR_STATUSES.map(status => <option key={status}>{status}</option>)}</select></label>
            <label><span>举办形式</span><select aria-label="招聘会举办形式" value={form.mode} onChange={event => update('mode', event.target.value as DesktopCareerFairInput['mode'])}>{CAREER_FAIR_MODES.map(mode => <option key={mode}>{mode}</option>)}</select></label>
            <label><span>开始时间</span><input required aria-label="招聘会开始时间" type="datetime-local" value={form.startsAt} onChange={event => update('startsAt', event.target.value)} /></label>
            <label><span>结束时间</span><input aria-label="招聘会结束时间" type="datetime-local" value={form.endsAt} onChange={event => update('endsAt', event.target.value)} /></label>
            <label className="form-span-two"><span>地点 / 线上会议说明</span><input aria-label="招聘会地点" value={form.location} onChange={event => update('location', event.target.value)} placeholder="例如：中心校区会展中心一楼 / 视频会议" /></label>
            <label><span>主办方</span><input aria-label="招聘会主办方" value={form.organizer} onChange={event => update('organizer', event.target.value)} placeholder="学校、学院或招聘平台" /></label>
            <label><span>报名截止时间</span><input aria-label="招聘会报名截止时间" type="datetime-local" value={form.registrationDeadline} onChange={event => update('registrationDeadline', event.target.value)} /></label>
            <label className="form-span-two"><span>报名 / 详情链接</span><input aria-label="招聘会链接" type="url" value={form.eventUrl} onChange={event => update('eventUrl', event.target.value)} placeholder="https://" /></label>
            <label><span>目标公司</span><textarea aria-label="招聘会目标公司" rows={3} value={form.targetCompanies} onChange={event => update('targetCompanies', event.target.value)} placeholder="准备重点沟通的公司" /></label>
            <label><span>目标岗位</span><textarea aria-label="招聘会目标岗位" rows={3} value={form.targetRoles} onChange={event => update('targetRoles', event.target.value)} placeholder="算法、Agent、后端等" /></label>
            <label className="form-span-two"><span>准备事项</span><textarea aria-label="招聘会准备事项" rows={3} value={form.preparation} onChange={event => update('preparation', event.target.value)} placeholder="纸质简历、作品集、成绩单、问题清单等" /></label>
            <label className="form-span-two"><span>备注</span><textarea aria-label="招聘会备注" rows={4} value={form.notes} onChange={event => update('notes', event.target.value)} placeholder="展位、联系人、现场沟通结果或后续动作" /></label>
          </div>
          <div className="panel-actions sticky-actions">
            <button type="button" className="button-secondary" onClick={onClose}>取消</button>
            <button type="submit" className="button-primary" disabled={busy}>{busy ? '保存中…' : '保存招聘会'}</button>
          </div>
        </form>
      </aside>
    </div>
  );
}

function emptyCareerFairInput(): DesktopCareerFairInput {
  const start = new Date();
  start.setHours(19, 0, 0, 0);
  return {
    name: '',
    status: '计划参加',
    startsAt: localDateTime(start),
    endsAt: '',
    mode: '线下',
    location: '',
    organizer: '',
    registrationDeadline: '',
    eventUrl: '',
    targetCompanies: '',
    targetRoles: '',
    preparation: '',
    notes: '',
  };
}

function localDateTime(date: Date): string {
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return offsetDate.toISOString().slice(0, 16);
}
