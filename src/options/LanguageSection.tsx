import React from 'react';
import type { LanguageInfo } from '../shared/types.ts';
import { sectionStyles as styles } from './sectionStyles.ts';

interface Props {
  items: LanguageInfo[];
  onChange: (items: LanguageInfo[]) => void;
}

export function LanguageSection({ items, onChange }: Props) {
  const update = (index: number, field: keyof LanguageInfo, value: string) => {
    onChange(items.map((item, current) =>
      current === index ? { ...item, [field]: value } : item
    ));
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div>
      <h2 style={styles.sectionTitle}>外语能力</h2>
      <p style={styles.description}>
        按网站选项的常见写法填写，例如“英语 / 大学英语六级 / 通过”或“英语 / 雅思 / 7.0”。
      </p>

      {items.length === 0 && (
        <div style={styles.empty}>还没有外语能力记录，点击下方按钮添加。</div>
      )}

      {items.map((item, index) => (
        <div key={item.id || index} style={styles.card}>
          <div style={styles.cardHeader}>
            <span style={styles.cardIndex}>{`外语 ${index + 1}`}</span>
            <div style={styles.cardActions}>
              <button type="button" onClick={() => move(index, -1)} disabled={index === 0} style={styles.iconButton}>上移</button>
              <button type="button" onClick={() => move(index, 1)} disabled={index === items.length - 1} style={styles.iconButton}>下移</button>
              <button type="button" onClick={() => onChange(items.filter((_, current) => current !== index))} style={styles.removeButton}>删除</button>
            </div>
          </div>

          <div style={styles.row}>
            <div style={styles.group}>
              <label style={styles.label}>外语语种</label>
              <input
                value={item.language || ''}
                onChange={event => update(index, 'language', event.target.value)}
                style={styles.input}
                placeholder="如 英语"
              />
            </div>
            <div style={styles.group}>
              <label style={styles.label}>证书 / 考试类型</label>
              <input
                value={item.certificate || ''}
                onChange={event => update(index, 'certificate', event.target.value)}
                style={styles.input}
                placeholder="如 大学英语六级、雅思"
              />
            </div>
            <div style={styles.group}>
              <label style={styles.label}>等级 / 成绩</label>
              <input
                value={item.level || ''}
                onChange={event => update(index, 'level', event.target.value)}
                style={styles.input}
                placeholder="如 通过、熟练、7.0"
              />
            </div>
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={() => onChange([...items, {
          id: crypto.randomUUID(),
          language: '',
          certificate: '',
          level: '',
        }])}
        style={styles.addButton}
      >
        添加外语能力
      </button>
    </div>
  );
}
