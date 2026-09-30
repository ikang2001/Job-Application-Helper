import React, { useEffect, useState } from 'react';

interface PollingIntervalControlProps {
  label: string;
  minutes: number;
  min: number;
  max: number;
  step: number;
  busy: boolean;
  hint: string;
  onSave(minutes: number): void;
}

export function PollingIntervalControl(props: PollingIntervalControlProps) {
  const [draft, setDraft] = useState(String(props.minutes));
  useEffect(() => { setDraft(String(props.minutes)); }, [props.minutes]);
  const value = Number(draft);
  const valid = draft.trim() !== '' && Number.isInteger(value) && value >= props.min
    && value <= props.max && (value - props.min) % props.step === 0;
  return (
    <form className="polling-interval-setting" onSubmit={event => {
      event.preventDefault();
      if (valid && !props.busy) props.onSave(value);
    }}>
      <label>
        <span>{props.label}</span>
        <input type="number" aria-label={props.label} min={props.min} max={props.max} step={props.step}
          value={draft} disabled={props.busy} onChange={event => setDraft(event.target.value)} required />
        <span>分钟</span>
      </label>
      <button type="submit" className="button-secondary" disabled={props.busy || !valid || value === props.minutes}>
        保存间隔
      </button>
      <small>当前设置：{props.minutes} 分钟。{props.hint}</small>
      {!valid && <small role="alert">请输入 {props.min}～{props.max} 之间、步长为 {props.step} 的整数分钟。</small>}
    </form>
  );
}
