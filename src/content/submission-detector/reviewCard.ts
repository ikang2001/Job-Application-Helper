import type { SubmissionMetadataSnapshot, SubmissionSession } from './types.ts';

const REVIEW_CARD_ID = 'job-application-helper-submission-review';

export interface SubmissionReviewActions {
  onConfirm(metadata: Partial<SubmissionMetadataSnapshot>): void;
  onIgnore(): void;
}

export function updateSubmissionReviewCard(
  document: Document,
  session: SubmissionSession,
  actions: SubmissionReviewActions,
): void {
  document.getElementById(REVIEW_CARD_ID)?.remove();
  if (!session.pending || session.pending.state !== 'pending') return;

  const card = document.createElement('aside');
  card.id = REVIEW_CARD_ID;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', '确认投递记录');
  Object.assign(card.style, {
    position: 'fixed', right: '20px', bottom: '20px', zIndex: '2147483647',
    width: '340px', padding: '18px', border: '1px solid #c7d2fe', borderRadius: '16px',
    background: '#ffffff', color: '#172033', boxShadow: '0 18px 50px rgba(31, 41, 90, .22)',
    fontFamily: 'Inter, "Microsoft YaHei", sans-serif', lineHeight: '1.5',
  });

  const title = document.createElement('strong');
  title.textContent = session.score >= 0.9 ? '检测到投递成功' : '可能已完成投递';
  Object.assign(title.style, { display: 'block', fontSize: '16px', marginBottom: '4px' });
  card.append(title);

  const subtitle = document.createElement('p');
  subtitle.textContent = `置信度 ${Math.round(session.score * 100)}%，保存前请确认岗位信息。`;
  Object.assign(subtitle.style, { margin: '0 0 12px', color: '#64748b', fontSize: '12px' });
  card.append(subtitle);

  const values: Partial<SubmissionMetadataSnapshot> = { ...session.context.metadata };
  const summary = document.createElement('div');
  summary.append(
    summaryLine(document, '公司', values.companyName || '未识别'),
    summaryLine(document, '岗位', values.jobTitle || '未识别'),
    summaryLine(document, '地点', values.location || '未识别'),
  );
  card.append(summary);

  const editor = document.createElement('div');
  editor.hidden = true;
  const fields: Array<[keyof SubmissionMetadataSnapshot, string]> = [
    ['companyName', '公司'], ['jobTitle', '岗位'], ['jobId', 'Job ID'], ['location', '地点'],
  ];
  for (const [key, label] of fields) {
    const input = document.createElement('input');
    input.value = String(values[key] ?? '');
    input.placeholder = label;
    input.setAttribute('aria-label', label);
    Object.assign(input.style, {
      boxSizing: 'border-box', width: '100%', marginTop: '8px', padding: '8px 10px',
      border: '1px solid #d7ddea', borderRadius: '8px', font: 'inherit',
    });
    input.addEventListener('input', () => { values[key] = input.value.trim() as never; });
    editor.append(input);
  }
  card.append(editor);

  const actionsRow = document.createElement('div');
  Object.assign(actionsRow.style, { display: 'flex', gap: '8px', marginTop: '14px' });
  actionsRow.append(
    actionButton(document, '保存', '#4f46e5', '#ffffff', () => actions.onConfirm(values)),
    actionButton(document, '修改', '#eef2ff', '#3730a3', () => {
      editor.hidden = false;
      summary.hidden = true;
    }),
    actionButton(document, '忽略', '#f8fafc', '#475569', actions.onIgnore),
  );
  card.append(actionsRow);
  document.documentElement.append(card);
}

export function removeSubmissionReviewCard(document: Document): void {
  document.getElementById(REVIEW_CARD_ID)?.remove();
}

function summaryLine(document: Document, label: string, value: string): HTMLElement {
  const row = document.createElement('div');
  Object.assign(row.style, { display: 'grid', gridTemplateColumns: '58px 1fr', gap: '8px', fontSize: '13px' });
  const name = document.createElement('span');
  name.textContent = label;
  name.style.color = '#64748b';
  const content = document.createElement('span');
  content.textContent = value;
  content.style.overflowWrap = 'anywhere';
  row.append(name, content);
  return row;
}

function actionButton(
  document: Document,
  text: string,
  background: string,
  color: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  Object.assign(button.style, {
    flex: '1', padding: '8px 10px', border: '0', borderRadius: '9px',
    background, color, fontWeight: '650', cursor: 'pointer',
  });
  button.addEventListener('click', onClick);
  return button;
}
