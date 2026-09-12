import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ApplicationRecord } from '../../../src/shared/types.ts';
import type {
  CareerFair,
  DesktopApi,
  DesktopCareerFairInput,
  DesktopMailReview,
  DesktopMailReviewDecisionInput,
  DesktopRecordInput,
  DesktopRecordSaveResult,
  DesktopResult,
  DesktopState,
} from '../shared/contracts.ts';
import { desktopRecordInput, saveDesktopRecord } from '../domain/records.ts';
import App from './App.tsx';
import { MailInboxView } from './MailInboxView.tsx';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-09-04T08:00:00.000Z';

function record(overrides: Partial<DesktopRecordInput> = {}): ApplicationRecord {
  return saveDesktopRecord([], {
    companyName: '示例科技',
    jobTitle: '前端工程师',
    sourceSite: 'jobs.example.com',
    sourceUrl: 'https://jobs.example.com/123',
    status: '已投递',
    notes: '',
    appliedAt: '2026-09-04',
    location: '上海',
    ...overrides,
  }, NOW).record;
}

function careerFair(overrides: Partial<CareerFair> = {}): CareerFair {
  return {
    id: 'fair-1',
    name: '西北工业大学秋季双选会',
    status: '已报名',
    startsAt: '2026-09-12T09:00',
    endsAt: '2026-09-12T16:00',
    mode: '线下',
    location: '长安校区启真楼一楼',
    organizer: '就业指导中心',
    registrationDeadline: '2026-09-11T18:00',
    eventUrl: 'https://career.example.com/fair',
    targetCompanies: '示例科技、未来智能',
    targetRoles: 'Agent 开发工程师',
    preparation: '纸质简历 5 份、成绩单',
    notes: '优先去 A 区展位',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function state(
  records: ApplicationRecord[],
  careerFairs: CareerFair[] = [],
  favoriteRecordIds: string[] = [],
  desktopReminder = { enabled: true, supported: true },
): DesktopState {
  return {
    records,
    favoriteRecordIds,
    careerFairs,
    desktopReminder,
    localSync: { status: 'synced', lastSyncedAt: NOW, recordCount: records.length },
    mobileSync: { configured: false, enabled: false, serverUrl: '', status: 'disabled' },
    mailInbox: { status: 'idle', accounts: [], reviews: [], pendingCount: 0 },
    sync: { status: 'disabled' },
    webdav: { enabled: false, serverUrl: '', username: '', passwordConfigured: false },
  };
}

function desktopApi(
  initialState: DesktopState,
  saveResult: DesktopResult<DesktopRecordSaveResult>,
): DesktopApi {
  return {
    getState: async () => ({ success: true, data: initialState }),
    onStateChanged: () => () => {},
    saveRecord: async () => saveResult,
    deleteRecord: async () => ({ success: false, error: '未实现' }),
    setRecordFavorite: async () => ({ success: false, error: '未实现' }),
    saveCareerFair: async () => ({ success: false, error: '未实现' }),
    deleteCareerFair: async () => ({ success: false, error: '未实现' }),
    importJson: async () => ({ success: false, error: '未实现' }),
    exportJson: async () => ({ success: false, error: '未实现' }),
    importCsv: async () => ({ success: false, error: '未实现' }),
    exportCsv: async () => ({ success: false, error: '未实现' }),
    saveWebDav: async () => ({ success: false, error: '未实现' }),
    testWebDav: async () => ({ success: false, error: '未实现' }),
    syncNow: async () => ({ success: false, error: '未实现' }),
    resolveConflict: async () => ({ success: false, error: '未实现' }),
    setupMobileSync: async () => ({ success: false, error: '未实现' }),
    setMobileSyncEnabled: async () => ({ success: false, error: '未实现' }),
    setDesktopReminderEnabled: async () => ({ success: false, error: '未实现' }),
    syncMobileNow: async () => ({ success: false, error: '未实现' }),
    getMobilePairing: async () => ({ success: false, error: '未实现' }),
    scanMail: async () => ({ success: false, error: '未实现' }),
    confirmMailReview: async () => ({ success: false, error: '未实现' }),
    ignoreMailReview: async () => ({ success: false, error: '未实现' }),
    ignoreMailReviews: async () => ({ success: false, error: '未实现' }),
    openExternal: async () => ({ success: true }),
  };
}

async function render(api: DesktopApi): Promise<TestRenderer.ReactTestRenderer> {
  globalThis.window = { desktopApi: api } as Window & typeof globalThis;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<App />);
    await Promise.resolve();
  });
  return renderer;
}

function text(node: TestRenderer.ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : text(child)).join('');
}

function button(renderer: TestRenderer.ReactTestRenderer, label: string): TestRenderer.ReactTestInstance {
  return renderer.root.findAllByType('button').find(candidate => text(candidate) === label)
    ?? assert.fail(`未找到按钮：${label}`);
}

async function submitOpenForm(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  const form = renderer.root.findByProps({ className: 'record-form' });
  await act(async () => {
    form.props.onSubmit({ preventDefault() {} });
    await Promise.resolve();
    await Promise.resolve();
  });
}

test('桌面端新建记录保存成功后返回列表', async () => {
  const originalWindow = globalThis.window;
  const savedRecord = record();
  const nextState = state([savedRecord]);
  const renderer = await render(desktopApi(state([]), {
    success: true,
    data: { state: nextState, recordId: savedRecord.id },
  }));

  try {
    await act(async () => button(renderer, '＋ 新建记录').props.onClick());
    assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 1);
    await submitOpenForm(renderer);
    assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);
    assert.match(text(renderer.root), /投递记录已保存/);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.window = originalWindow;
  }
});

test('桌面提醒可独立关闭且近期安排入口始终保留', async () => {
  const originalWindow = globalThis.window;
  const initialState = state([]);
  const api = desktopApi(initialState, { success: false, error: '未使用' });
  let savedEnabled: boolean | undefined;
  api.setDesktopReminderEnabled = async enabled => {
    savedEnabled = enabled;
    return { success: true, data: state([], [], [], { enabled, supported: true }) };
  };
  const renderer = await render(api);

  try {
    assert.match(text(renderer.root), /桌面提醒已开启 · 24h \/ 5h/);
    assert.match(text(renderer.root), /近期安排暂无安排/);
    await act(async () => {
      renderer.root.findByProps({ 'aria-label': '桌面提醒已开启，点击关闭' }).props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(savedEnabled, false);
    assert.match(text(renderer.root), /桌面提醒已关闭/);
    assert.match(text(renderer.root), /近期安排暂无安排/);
    assert.match(text(renderer.root), /手机提醒不受影响/);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.window = originalWindow;
  }
});

test('近期安排按独立入口展示下一项及开始截止语义', async () => {
  const originalWindow = globalThis.window;
  const scheduled = record({
    companyName: '新华三集团',
    jobTitle: 'AI 大模型算法工程师',
    recruitmentSchedule: {
      assessment: {
        scheduledAt: '2099-09-25T13:47',
        url: 'https://assessment.example.com/h3c',
        timeKind: 'deadline',
      },
    },
  });
  let currentRecords = [scheduled];
  const api = desktopApi(state(currentRecords), { success: false, error: '未使用' });
  let lastSavedInput: DesktopRecordInput | undefined;
  api.saveRecord = async input => {
    lastSavedInput = input;
    const saved = saveDesktopRecord(currentRecords, input, '2026-09-10T16:00:00.000Z');
    currentRecords = saved.records;
    return {
      success: true,
      data: { state: state(currentRecords), recordId: saved.record.id },
    };
  };
  const renderer = await render(api);

  try {
    await act(async () => renderer.root.findByProps({ 'aria-label': '查看近期安排，共 1 项' }).props.onClick());
    const panel = renderer.root.findByProps({ 'aria-label': '近期安排' });
    assert.match(text(panel), /新华三集团/);
    assert.match(text(panel), /测评截止/);
    assert.match(text(panel), /AI 大模型算法工程师/);
    assert.match(text(panel), /桌面弹窗提醒已开启/);
    await act(async () => {
      button(renderer, '✓ 标记已完成').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.ok(lastSavedInput?.recruitmentSchedule?.assessment?.completedAt);
    assert.match(text(panel), /待处理\s*0/);
    assert.match(text(panel), /已完成\s*1/);
    await act(async () => button(renderer, '已完成 1').props.onClick());
    assert.match(text(panel), /已经停止提醒的安排/);
    assert.match(text(panel), /测评截止 · 已完成/);
    await act(async () => {
      button(renderer, '撤销完成').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(lastSavedInput?.recruitmentSchedule?.assessment?.completedAt, undefined);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.window = originalWindow;
  }
});

test('桌面端编辑记录保存成功后返回列表', async () => {
  const originalWindow = globalThis.window;
  const savedRecord = record();
  const initialState = state([savedRecord]);
  const renderer = await render(desktopApi(initialState, {
    success: true,
    data: { state: initialState, recordId: savedRecord.id },
  }));

  try {
    await act(async () => button(renderer, '示例科技前端工程师').props.onClick());
    await act(async () => button(renderer, '编辑记录').props.onClick());
    await submitOpenForm(renderer);
    assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.window = originalWindow;
  }
});

test('桌面端保存失败时保留编辑面板', async () => {
  const originalWindow = globalThis.window;
  const renderer = await render(desktopApi(state([]), {
    success: false,
    error: '本地保存失败',
  }));

  try {
    await act(async () => button(renderer, '＋ 新建记录').props.onClick());
    await submitOpenForm(renderer);
    assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 1);
    assert.match(text(renderer.root), /本地保存失败/);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.window = originalWindow;
  }
});

test('左侧最上方招聘会栏目展示时间地点和求职准备信息', async () => {
  const originalWindow = globalThis.window;
  const renderer = await render(desktopApi(state([], [careerFair()]), { success: false, error: '未使用' }));

  try {
    const fairButton = renderer.root.findByProps({ 'aria-label': '招聘会 1 场' });
    await act(async () => fairButton.props.onClick());
    const content = text(renderer.root);
    assert.match(content, /西北工业大学秋季双选会/);
    assert.match(content, /长安校区启真楼一楼/);
    assert.match(content, /示例科技、未来智能/);
    assert.match(content, /纸质简历 5 份、成绩单/);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.window = originalWindow;
  }
});

test('招聘邮件未经人工确认不改状态，确认时提交所选公司岗位和实际阶段', async () => {
  const originalWindow = globalThis.window;
  const first = record({ id: 'mail-record-1', companyName: '锐捷网络', jobTitle: 'AI 开发工程师' });
  const second = record({ id: 'mail-record-2', companyName: '锐捷网络', jobTitle: '算法工程师' });
  const review: DesktopMailReview = {
    id: 'mail-review-1',
    accountId: 'mail-account-1',
    messageId: 'message-1',
    from: 'campus@example.com',
    subject: '锐捷网络 AI面试邀约',
    receivedAt: NOW,
    summary: '请在规定时间内完成 AI 面试。',
    category: 'interview_invite',
    suggestedStage: 'ai',
    companyName: '锐捷网络',
    candidateRecordIds: [first.id, second.id],
    deadlineAt: '2026-09-05T08:00:00',
    actionUrl: 'https://assessment.example.com/ai',
    state: 'pending',
  };
  const initialState = state([first, second]);
  initialState.mailInbox = {
    status: 'idle',
    accounts: [{
      id: 'mail-account-1',
      provider: '163',
      emailAddress: 'candidate@163.com',
      displayName: '求职邮箱',
      connection: 'connected',
    }],
    reviews: [review],
    pendingCount: 1,
  };
  let decision: DesktopMailReviewDecisionInput | undefined;
  const api = desktopApi(initialState, { success: false, error: '未使用' });
  api.confirmMailReview = async (input) => {
    decision = input;
    return { success: true, data: initialState };
  };
  const renderer = await render(api);

  try {
    await act(async () => renderer.root.findByProps({ 'aria-label': '招聘邮箱 1 封待审核' }).props.onClick());
    assert.equal(initialState.records[0]?.status, '已投递');
    assert.equal(decision, undefined);

    const recordSelect = renderer.root.findByProps({ 'aria-label': '锐捷网络 AI面试邀约 对应投递岗位' });
    const stageSelect = renderer.root.findByProps({ 'aria-label': '锐捷网络 AI面试邀约 邮件阶段' });
    assert.equal(stageSelect.props.value, 'ai');
    await act(async () => recordSelect.props.onChange({ target: { value: second.id } }));
    await act(async () => stageSelect.props.onChange({ target: { value: 'first' } }));
    assert.equal(renderer.root.findByProps({ 'aria-label': '锐捷网络 AI面试邀约 邮件阶段' }).props.value, 'first');
    await act(async () => renderer.root.findByProps({ 'aria-label': '锐捷网络 AI面试邀约 邮件阶段' }).props.onChange({ target: { value: 'ai' } }));
    assert.equal(decision, undefined);

    await act(async () => {
      button(renderer, '确认并更新岗位').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(decision, {
      reviewId: review.id,
      recordId: second.id,
      stage: 'ai',
      scheduledAt: '2026-09-05T08:00',
      scheduleType: 'deadline',
      actionUrl: 'https://assessment.example.com/ai',
      notes: '',
    });
  } finally {
    await act(async () => renderer.unmount());
    globalThis.window = originalWindow;
  }
});

test('后台补齐邮件截止时间后当前审核卡片立即刷新且不覆盖人工时间', async () => {
  const current = record({ id: 'anker-record', companyName: '安克创新', jobTitle: 'AI应用工程师-深圳' });
  const review: DesktopMailReview = {
    id: 'anker-review',
    accountId: 'mail-account-1',
    messageId: 'message-anker',
    from: '安克创新招聘',
    subject: '【安克创新校招测评】2027届校园招聘',
    receivedAt: '2026-09-11T05:28:29.000Z',
    summary: '链接有效期5天，请合理安排时间。',
    category: 'assessment_invite',
    suggestedStage: 'assessment',
    companyName: '安克创新',
    candidateRecordIds: [current.id],
    state: 'pending',
  };
  const inbox = { status: 'idle' as const, accounts: [], reviews: [review], pendingCount: 1 };
  const renderView = (nextReview: DesktopMailReview) => (
    <MailInboxView
      inbox={{ ...inbox, reviews: [nextReview] }}
      records={[current]}
      busy={false}
      onScan={() => {}}
      onConfirm={() => {}}
      onIgnore={() => {}}
      onIgnoreMany={() => {}}
      onOpenUrl={() => {}}
    />
  );
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(renderView(review)); });

  try {
    const timeInput = () => renderer.root.findByProps({ 'aria-label': `${review.subject} 安排时间` });
    assert.equal(timeInput().props.value, '');
    await act(async () => {
      renderer.update(renderView({ ...review, deadlineAt: '2026-09-16T13:28:29' }));
    });
    assert.equal(timeInput().props.value, '2026-09-16T13:28');

    await act(async () => timeInput().props.onChange({ target: { value: '2026-09-15T20:00' } }));
    await act(async () => {
      renderer.update(renderView({ ...review, deadlineAt: '2026-09-16T13:29:00' }));
    });
    assert.equal(timeInput().props.value, '2026-09-15T20:00');
  } finally {
    await act(async () => renderer.unmount());
  }
});

test('未匹配邮件可按公司或岗位搜索投递记录且后台匹配后自动选中唯一岗位', async () => {
  const kingdee = record({ id: 'kingdee-record', companyName: '金蝶软件（中国）有限公司', jobTitle: 'AI agent开发工程师（深圳）' });
  const anker = record({ id: 'anker-record', companyName: '安克创新', jobTitle: 'AI应用工程师-深圳' });
  const review: DesktopMailReview = {
    id: 'kingdee-review',
    accountId: 'mail-account-1',
    messageId: 'message-kingdee',
    from: '招聘小秘书',
    subject: '来自金蝶2027届校园招聘的笔试邀请',
    receivedAt: '2026-09-11T07:24:21.000Z',
    summary: '请完成线上笔试。',
    category: 'assessment_invite',
    suggestedStage: 'writtenTest',
    candidateRecordIds: [],
    deadlineAt: '2026-09-13T15:24:21',
    state: 'pending',
  };
  const inbox = { status: 'idle' as const, accounts: [], reviews: [review], pendingCount: 1 };
  const renderView = (nextReview: DesktopMailReview) => (
    <MailInboxView
      inbox={{ ...inbox, reviews: [nextReview] }}
      records={[anker, kingdee]}
      busy={false}
      onScan={() => {}}
      onConfirm={() => {}}
      onIgnore={() => {}}
      onIgnoreMany={() => {}}
      onOpenUrl={() => {}}
    />
  );
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(renderView(review)); });

  try {
    const search = renderer.root.findByProps({ 'aria-label': `${review.subject} 搜索投递公司或岗位` });
    const select = () => renderer.root.findByProps({ 'aria-label': `${review.subject} 对应投递岗位` });
    await act(async () => search.props.onChange({ target: { value: '金蝶' } }));
    assert.match(text(select()), /金蝶软件（中国）有限公司/);
    assert.doesNotMatch(text(select()), /安克创新/);

    await act(async () => {
      renderer.update(renderView({
        ...review,
        companyName: kingdee.companyName,
        candidateRecordIds: [kingdee.id],
      }));
    });
    assert.equal(select().props.value, kingdee.id);
  } finally {
    await act(async () => renderer.unmount());
  }
});

test('招聘邮箱可全选当前待审核邮件并批量忽略且不修改岗位状态', async () => {
  const originalWindow = globalThis.window;
  const current = record({ id: 'batch-record-1', companyName: '汇川技术', jobTitle: '开发工程师' });
  const first: DesktopMailReview = {
    id: 'batch-review-1',
    accountId: 'mail-account-1',
    messageId: '201',
    from: 'campus@example.com',
    subject: '汇川技术测评通知',
    receivedAt: NOW,
    summary: '请完成人才测评。',
    category: 'assessment_invite',
    companyName: '汇川技术',
    candidateRecordIds: [current.id],
    state: 'pending',
  };
  const second: DesktopMailReview = {
    ...first,
    id: 'batch-review-2',
    messageId: '202',
    subject: '汇川技术招聘沟通',
  };
  const initialState = state([current]);
  initialState.mailInbox = {
    status: 'idle',
    accounts: [],
    reviews: [first, second],
    pendingCount: 2,
  };
  let ignoredIds: string[] | undefined;
  const api = desktopApi(initialState, { success: false, error: '未使用' });
  api.ignoreMailReviews = async (reviewIds) => {
    ignoredIds = reviewIds;
    return {
      success: true,
      data: {
        ...initialState,
        mailInbox: {
          ...initialState.mailInbox,
          reviews: initialState.mailInbox.reviews.map(review => ({ ...review, state: 'ignored' as const })),
          pendingCount: 0,
        },
      },
    };
  };
  const renderer = await render(api);
  globalThis.window.confirm = () => true;

  try {
    await act(async () => renderer.root.findByProps({ 'aria-label': '招聘邮箱 2 封待审核' }).props.onClick());
    await act(async () => button(renderer, '全选当前 2 封').props.onClick());
    await act(async () => {
      button(renderer, '批量忽略（2）').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(new Set(ignoredIds), new Set([first.id, second.id]));
    assert.equal(initialState.records[0]?.status, '已投递');
    assert.match(text(renderer.root), /已忽略 2 封邮件，投递岗位状态均未改变/);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.window = originalWindow;
  }
});

test('邮箱扫描成功提示在四秒后自动消失', async () => {
  const originalWindow = globalThis.window;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const initialState = state([]);
  const api = desktopApi(initialState, { success: false, error: '未使用' });
  api.scanMail = async () => ({ success: true, data: initialState });
  const renderer = await render(api);
  let scheduled: (() => void) | undefined;
  let scheduledDelay = 0;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number) => {
    scheduled = () => callback();
    scheduledDelay = Number(delay ?? 0);
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;

  try {
    await act(async () => renderer.root.findByProps({ 'aria-label': '招聘邮箱 0 封待审核' }).props.onClick());
    await act(async () => {
      button(renderer, '扫描邮箱').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(text(renderer.root), /邮箱扫描完成，当前 0 封待审核/);
    assert.equal(scheduledDelay, 4_000);
    await act(async () => {
      scheduled?.();
      await Promise.resolve();
    });
    assert.doesNotMatch(text(renderer.root), /邮箱扫描完成，当前 0 封待审核/);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.window = originalWindow;
  }
});

test('新建招聘会保存后返回招聘会列表', async () => {
  const originalWindow = globalThis.window;
  const initialState = state([]);
  const api = desktopApi(initialState, { success: false, error: '未使用' });
  let savedInput: DesktopCareerFairInput | undefined;
  api.saveCareerFair = async (input) => {
    savedInput = input;
    return { success: true, data: { state: state([], [careerFair({ name: input.name })]), careerFairId: 'fair-1' } };
  };
  const renderer = await render(api);

  try {
    await act(async () => renderer.root.findByProps({ 'aria-label': '招聘会 0 场' }).props.onClick());
    await act(async () => button(renderer, '＋ 新建招聘会').props.onClick());
    assert.match(renderer.root.findByProps({ 'aria-label': '招聘会开始时间' }).props.value, /T19:00$/);
    await act(async () => renderer.root.findByProps({ 'aria-label': '招聘会名称' }).props.onChange({ target: { value: '校级综合招聘会' } }));
    await act(async () => {
      renderer.root.findByProps({ className: 'record-form career-fair-form' }).props.onSubmit({ preventDefault() {} });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(savedInput?.name, '校级综合招聘会');
    assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);
    assert.match(text(renderer.root), /招聘会已保存/);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.window = originalWindow;
  }
});

test('左侧已投递汇总保留进入面试的记录并自动使用求职阶段排序', async () => {
  const originalWindow = globalThis.window;
  const renderer = await render(desktopApi(state([
    record({ companyName: '甲公司', jobTitle: '开发工程师', status: '已投递', sourceUrl: 'https://jobs.example.com/a' }),
    record({ companyName: '乙公司', jobTitle: '算法工程师', status: '面试中', sourceUrl: 'https://jobs.example.com/b' }),
    record({ companyName: '丙公司', jobTitle: '测试工程师', status: '待投递', sourceUrl: 'https://jobs.example.com/c' }),
  ]), { success: false, error: '未使用' }));

  try {
    const submittedButton = renderer.root.findByProps({ 'aria-label': '已投递汇总 2 条' });
    await act(async () => submittedButton.props.onClick());
    assert.equal(renderer.root.findByProps({ className: 'sort-field' }).findByType('select').props.value, 'stage');
    assert.match(text(renderer.root), /已投递汇总/);
    assert.match(text(renderer.root), /甲公司/);
    assert.match(text(renderer.root), /乙公司/);
    assert.doesNotMatch(text(renderer.root.findByProps({ className: 'records-table' })), /丙公司/);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.window = originalWindow;
  }
});

test('按公司查看把同一公司的多个岗位聚合展示', async () => {
  const originalWindow = globalThis.window;
  const renderer = await render(desktopApi(state([
    record({ jobTitle: '前端工程师', sourceUrl: 'https://jobs.example.com/frontend' }),
    record({ jobTitle: '后端工程师', sourceUrl: 'https://jobs.example.com/backend' }),
  ]), { success: false, error: '未使用' }));

  try {
    await act(async () => button(renderer, '按公司查看').props.onClick());
    const group = renderer.root.findByProps({ className: 'company-record-group' });
    assert.match(text(group), /示例科技/);
    assert.match(text(group), /2 个岗位/);
    assert.match(text(group), /前端工程师/);
    assert.match(text(group), /后端工程师/);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.window = originalWindow;
  }
});

test('特别关注入口只显示收藏记录，收藏页修改状态仍保存原投递记录', async () => {
  const originalWindow = globalThis.window;
  const favorite = record({ id: 'favorite-1', companyName: '最想去科技', jobTitle: 'Agent 工程师' });
  const ordinary = record({ id: 'ordinary-1', companyName: '普通科技', jobTitle: '后端工程师' });
  const initialState = state([favorite, ordinary], [], [favorite.id]);
  let savedInput: DesktopRecordInput | undefined;
  const api = desktopApi(initialState, { success: false, error: '未设置' });
  api.saveRecord = async (input) => {
    savedInput = input;
    const saved = saveDesktopRecord(initialState.records, input, '2026-09-05T08:00:00.000Z');
    return {
      success: true,
      data: { state: state(saved.records, [], [favorite.id]), recordId: saved.record.id },
    };
  };
  const renderer = await render(api);

  try {
    await act(async () => renderer.root.findByProps({ 'aria-label': '特别关注 1 条' }).props.onClick());
    const content = text(renderer.root);
    assert.match(content, /最想去科技/);
    assert.doesNotMatch(content, /普通科技/);

    const statusSelect = renderer.root.findByProps({ 'aria-label': '最想去科技 投递状态' });
    await act(async () => {
      statusSelect.props.onChange({ target: { value: '面试中' }, stopPropagation() {} });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(savedInput?.id, favorite.id);
    assert.equal(savedInput?.status, '面试中');
  } finally {
    await act(async () => renderer.unmount());
    globalThis.window = originalWindow;
  }
});

test('记录可加星收藏并在按公司查看中取消收藏', async () => {
  const originalWindow = globalThis.window;
  const current = record({ id: 'favorite-toggle-1' });
  const initialState = state([current]);
  const decisions: Array<{ recordId: string; favorite: boolean }> = [];
  const api = desktopApi(initialState, { success: false, error: '未使用' });
  api.setRecordFavorite = async (input) => {
    decisions.push(input);
    return { success: true, data: state([current], [], input.favorite ? [current.id] : []) };
  };
  const renderer = await render(api);

  try {
    await act(async () => {
      renderer.root.findByProps({ 'aria-label': '收藏 示例科技 前端工程师' }).props.onClick({ stopPropagation() {} });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(decisions[0], { recordId: current.id, favorite: true });
    assert.equal(renderer.root.findByProps({ 'aria-label': '特别关注 1 条' }).props['aria-label'], '特别关注 1 条');

    await act(async () => button(renderer, '按公司查看').props.onClick());
    await act(async () => {
      renderer.root.findByProps({ 'aria-label': '取消收藏 示例科技 前端工程师' }).props.onClick({ stopPropagation() {} });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(decisions[1], { recordId: current.id, favorite: false });
  } finally {
    await act(async () => renderer.unmount());
    globalThis.window = originalWindow;
  }
});

test('列表状态下拉直接保存同一记录并立即显示新状态', async () => {
  const originalWindow = globalThis.window;
  const current = record();
  const initialState = state([current]);
  let savedInput: DesktopRecordInput | undefined;
  const api = desktopApi(initialState, { success: false, error: '未设置' });
  api.saveRecord = async (input) => {
    savedInput = input;
    const saved = saveDesktopRecord(initialState.records, input, '2026-09-05T08:00:00.000Z');
    return {
      success: true,
      data: { state: state(saved.records), recordId: saved.record.id },
    };
  };
  const renderer = await render(api);

  try {
    const statusSelect = renderer.root.findByProps({ 'aria-label': '示例科技 投递状态' });
    await act(async () => {
      statusSelect.props.onChange({ target: { value: '笔试/测评' }, stopPropagation() {} });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(savedInput, { ...desktopRecordInput(current), status: '笔试/测评' });
    assert.equal(renderer.root.findByProps({ 'aria-label': '示例科技 投递状态' }).props.value, '笔试/测评');
    assert.match(text(renderer.root), /投递状态已保存，并已写入 Edge 同步区/);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.window = originalWindow;
  }
});

test('列表备注可保存面试链接并保留记录 ID', async () => {
  const originalWindow = globalThis.window;
  const current = record();
  const initialState = state([current]);
  let savedInput: DesktopRecordInput | undefined;
  const api = desktopApi(initialState, { success: false, error: '未设置' });
  api.saveRecord = async (input) => {
    savedInput = input;
    const saved = saveDesktopRecord(initialState.records, input, '2026-09-05T08:00:00.000Z');
    return {
      success: true,
      data: { state: state(saved.records), recordId: saved.record.id },
    };
  };
  const renderer = await render(api);
  const interviewUrl = 'https://meeting.example.com/interview/123';

  try {
    await act(async () => {
      renderer.root.findByProps({ 'aria-label': '示例科技 备注' }).props.onChange({ target: { value: interviewUrl } });
    });
    await act(async () => {
      renderer.root.findByProps({ 'aria-label': '保存 示例科技 备注' }).props.onClick?.({ stopPropagation() {} });
      renderer.root.findByProps({ 'aria-label': '保存 示例科技 备注' }).parent?.props.onSubmit({ preventDefault() {}, stopPropagation() {} });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(savedInput?.id, current.id);
    assert.equal(savedInput?.notes, interviewUrl);
    assert.equal(renderer.root.findByProps({ 'aria-label': '示例科技 备注' }).props.value, interviewUrl);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.window = originalWindow;
  }
});

test('列表快捷保存失败时回滚状态并显示错误', async () => {
  const originalWindow = globalThis.window;
  const current = record();
  const renderer = await render(desktopApi(state([current]), {
    success: false,
    error: '共享文件暂时不可写',
  }));

  try {
    const statusSelect = renderer.root.findByProps({ 'aria-label': '示例科技 投递状态' });
    await act(async () => {
      statusSelect.props.onChange({ target: { value: '面试中' }, stopPropagation() {} });
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(renderer.root.findByProps({ 'aria-label': '示例科技 投递状态' }).props.value, '已投递');
    assert.match(text(renderer.root), /共享文件暂时不可写/);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.window = originalWindow;
  }
});

test('列表可用默认浏览器直接打开备注中的链接', async () => {
  const originalWindow = globalThis.window;
  const interviewUrl = 'https://meeting.example.com/interview/123';
  const current = { ...record(), notes: `面试链接：${interviewUrl}` };
  const api = desktopApi(state([current]), { success: false, error: '未使用' });
  let openedUrl = '';
  api.openExternal = async (url) => {
    openedUrl = url;
    return { success: true };
  };
  const renderer = await render(api);

  try {
    await act(async () => {
      renderer.root.findByProps({ 'aria-label': '打开 示例科技 备注链接' }).props.onClick({ stopPropagation() {} });
      await Promise.resolve();
    });
    assert.equal(openedUrl, interviewUrl);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.window = originalWindow;
  }
});

test('编辑安排可分别保存笔试、测评和每轮面试的时间与链接', async () => {
  const originalWindow = globalThis.window;
  const current = record();
  const initialState = state([current]);
  let savedInput: DesktopRecordInput | undefined;
  const api = desktopApi(initialState, { success: false, error: '未设置' });
  api.saveRecord = async (input) => {
    savedInput = input;
    const saved = saveDesktopRecord(initialState.records, input, '2026-09-05T08:00:00.000Z');
    return { success: true, data: { state: state(saved.records), recordId: saved.record.id } };
  };
  const renderer = await render(api);
  const values = {
    笔试时间: '2026-09-10T19:00',
    笔试链接: 'https://exam.example.com/written',
    测评时间: '2026-09-11T14:30',
    测评链接: 'https://exam.example.com/assessment',
    AI面时间: '2026-09-12T10:00',
    AI面链接: 'https://meeting.example.com/ai',
    一面时间: '2026-09-13T10:00',
    一面链接: 'https://meeting.example.com/first',
    二面时间: '2026-09-14T10:00',
    二面链接: 'https://meeting.example.com/second',
    三面时间: '2026-09-15T10:00',
    三面链接: 'https://meeting.example.com/third',
    HR面时间: '2026-09-16T10:00',
    HR面链接: 'https://meeting.example.com/hr',
  };

  try {
    await act(async () => button(renderer, '＋ 填写安排').props.onClick());
    for (const [label, value] of Object.entries(values)) {
      await act(async () => renderer.root.findByProps({ 'aria-label': label }).props.onChange({ target: { value } }));
    }
    await submitOpenForm(renderer);

    assert.deepEqual(savedInput?.recruitmentSchedule, {
      writtenTest: { scheduledAt: values.笔试时间, url: values.笔试链接 },
      assessment: { scheduledAt: values.测评时间, url: values.测评链接 },
      interviews: {
        ai: { scheduledAt: values.AI面时间, url: values.AI面链接 },
        first: { scheduledAt: values.一面时间, url: values.一面链接 },
        second: { scheduledAt: values.二面时间, url: values.二面链接 },
        third: { scheduledAt: values.三面时间, url: values.三面链接 },
        hr: { scheduledAt: values.HR面时间, url: values.HR面链接 },
      },
    });
  } finally {
    await act(async () => renderer.unmount());
    globalThis.window = originalWindow;
  }
});

test('列表可分别直接打开笔试、测评和每轮面试链接', async () => {
  const originalWindow = globalThis.window;
  const current = {
    ...record(),
    recruitmentSchedule: {
      writtenTest: { scheduledAt: '2026-09-10T19:00', url: 'https://exam.example.com/written' },
      assessment: { scheduledAt: '2026-09-11T14:30', url: 'https://exam.example.com/assessment' },
      interviews: {
        ai: { scheduledAt: '2026-09-12T10:00', url: 'https://meeting.example.com/ai' },
        first: { scheduledAt: '2026-09-13T10:00', url: 'https://meeting.example.com/first' },
        second: { scheduledAt: '2026-09-14T10:00', url: 'https://meeting.example.com/second' },
        third: { scheduledAt: '2026-09-15T10:00', url: 'https://meeting.example.com/third' },
        hr: { scheduledAt: '2026-09-16T10:00', url: 'https://meeting.example.com/hr' },
      },
    },
  };
  const api = desktopApi(state([current]), { success: false, error: '未使用' });
  const openedUrls: string[] = [];
  api.openExternal = async (url) => {
    openedUrls.push(url);
    return { success: true };
  };
  const renderer = await render(api);

  try {
    for (const stage of ['笔试', '测评', 'AI面', '一面', '二面', '三面', 'HR面']) {
      await act(async () => {
        renderer.root.findByProps({ 'aria-label': `打开 示例科技 ${stage}链接` }).props.onClick();
        await Promise.resolve();
      });
    }
    assert.deepEqual(openedUrls, [
      'https://exam.example.com/written',
      'https://exam.example.com/assessment',
      'https://meeting.example.com/ai',
      'https://meeting.example.com/first',
      'https://meeting.example.com/second',
      'https://meeting.example.com/third',
      'https://meeting.example.com/hr',
    ]);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.window = originalWindow;
  }
});
