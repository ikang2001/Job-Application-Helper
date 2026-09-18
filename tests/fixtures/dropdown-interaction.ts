import { FormFiller } from '../../src/content/formFiller';
import { FieldType, type DetectedField } from '../../src/shared/types';
import { createEmptyUserProfile } from '../../src/shared/resumeProfiles';

// 使用真实 DOM/focusin/IntersectionObserver，覆盖 plain-object mock 无法表现的
// 浏览器焦点与平滑滚动。控件仅模拟公开 ATS 控件的交互契约，不连接招聘接口。
const host = document.querySelector<HTMLElement>('#fields')!;
const result = document.querySelector<HTMLElement>('#result')!;
const traces: string[] = [];
const observers: IntersectionObserver[] = [];

function picker(label: string, fieldType: FieldType, expected: string, remote = false): DetectedField {
  const field = document.createElement('section');
  field.className = 'md-form-item';
  field.innerHTML = `<label>${label}</label><div class="ihr_base_picker${remote ? ' ihr_input_selector' : ''}"><input placeholder="${remote ? '请输入学校名称搜索' : '请选择'}"></div>`;
  const root = field.querySelector<HTMLElement>('.ihr_base_picker')!;
  const input = field.querySelector('input')!;
  const panel = document.createElement('div');
  panel.className = 'ihr_base_picker-panel';
  panel.hidden = true;
  document.body.append(panel);
  let focused = false;
  let timer: ReturnType<typeof setTimeout>;
  root.addEventListener('focusin', () => { focused = true; traces.push(`${label}:focusin`); });
  root.addEventListener('focusout', () => { focused = false; panel.hidden = true; });
  root.addEventListener('click', () => {
    traces.push(`${label}:open focus=${focused}`);
    panel.hidden = !focused;
    const rect = root.getBoundingClientRect();
    panel.style.top = `${window.scrollY + rect.bottom}px`;
    panel.style.left = `${rect.left}px`;
  });
  const option = () => {
    panel.innerHTML = `<div class="ihr_picker_menu-item"><div class="ihr_picker_menu-item_label">${expected}</div></div>`;
    panel.querySelector<HTMLElement>('.ihr_picker_menu-item')!.onclick = () => {
      traces.push(`${label}:option-click`);
      queueMicrotask(() => {
        const selected = document.createElement('span');
        selected.className = 'ihr_base_picker-single_selected';
        selected.textContent = expected;
        root.querySelector('.ihr_base_picker-single_selected')?.remove();
        root.append(selected);
        input.value = '';
        panel.hidden = true;
      });
    };
  };
  if (!remote) option();
  input.addEventListener('input', () => {
    if (!remote) return;
    clearTimeout(timer);
    panel.replaceChildren();
    traces.push(`${label}:search`);
    timer = setTimeout(() => { if (input.value === expected) option(); }, 350);
  });
  const observer = new IntersectionObserver(entries => {
    if (!entries[0]?.isIntersecting) {
      panel.hidden = true;
      traces.push(`${label}:offscreen-close`);
    }
  });
  observer.observe(root);
  observers.push(observer);
  host.append(field);
  return { element: input, fieldType, confidence: 1 };
}

async function run() {
  observers.splice(0).forEach(observer => observer.disconnect());
  document.querySelectorAll('.ihr_base_picker-panel').forEach(panel => panel.remove());
  host.replaceChildren();
  traces.length = 0;
  const fields = [
    picker('证件类型', FieldType.ID_TYPE, '身份证'),
    picker('手机区号', FieldType.PHONE_COUNTRY_CODE, '中国大陆 +86'),
    picker('学校', FieldType.SCHOOL, '示例大学', true),
  ];
  const profile = createEmptyUserProfile();
  profile.personal.idType = '身份证';
  profile.personal.phoneCountryCode = '+86';
  profile.education = [{ id: 'test', school: '示例大学', major: '', degree: '', startDate: '', endDate: '' }];
  const started = performance.now();
  const filler = new FormFiller();
  const accepted = await filler.fillForm(fields, profile);
  result.textContent = JSON.stringify({
    accepted, total: fields.length, elapsedMs: Math.round(performance.now() - started),
    diagnostics: filler.getLastFillDiagnostics(), traces,
  }, null, 2);
}

document.querySelector('#run')!.addEventListener('click', () => { void run(); });
document.querySelector('#background')!.addEventListener('click', () => {
  result.textContent = '等待后台测试开始';
  setTimeout(() => { void run(); }, 3000);
});
