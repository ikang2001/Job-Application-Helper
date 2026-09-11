import {
  completedScheduleItems,
  filterScheduleItems,
  scheduleDisplayLabel,
  scheduleEntries,
  upcomingScheduleItems,
} from './schedules.js?v=9';

const DB_NAME = 'job-application-helper-mobile';
const DB_VERSION = 1;
const STORE_NAME = 'private-state';
const ACTIVE_STATUSES = new Set(['已投递', '笔试/测评', '面试中']);
const FILTERS = ['全部', '已投递', '笔试/测评', '面试中', 'offer'];

const elements = {
  unpaired: document.querySelector('#unpaired-view'),
  paired: document.querySelector('#paired-view'),
  syncCaption: document.querySelector('#sync-caption'),
  refresh: document.querySelector('#refresh-button'),
  install: document.querySelector('#install-button'),
  notification: document.querySelector('#notification-button'),
  reminderDialog: document.querySelector('#reminder-dialog'),
  reminderBackdrop: document.querySelector('#reminder-backdrop'),
  reminderClose: document.querySelector('#reminder-close'),
  pushPlusStatus: document.querySelector('#pushplus-status'),
  pushPlusToken: document.querySelector('#pushplus-token'),
  pushPlusSave: document.querySelector('#pushplus-save'),
  pushPlusTest: document.querySelector('#pushplus-test'),
  pushPlusDisable: document.querySelector('#pushplus-disable'),
  webPushStatus: document.querySelector('#webpush-status'),
  webPushToggle: document.querySelector('#webpush-toggle'),
  total: document.querySelector('#metric-total'),
  active: document.querySelector('#metric-active'),
  upcoming: document.querySelector('#metric-upcoming'),
  recordSearch: document.querySelector('#record-search'),
  fairSearch: document.querySelector('#fair-search'),
  statusFilters: document.querySelector('#status-filters'),
  recordList: document.querySelector('#record-list'),
  fairList: document.querySelector('#fair-list'),
  scheduleList: document.querySelector('#schedule-list'),
  scheduleTotal: document.querySelector('#schedule-total'),
  schedulePendingCount: document.querySelector('#schedule-pending-count'),
  scheduleCompletedCount: document.querySelector('#schedule-completed-count'),
  scheduleCategoryTabs: document.querySelector('.schedule-category-tabs'),
  applicationsSection: document.querySelector('#applications-section'),
  schedulesSection: document.querySelector('#schedules-section'),
  careerFairsSection: document.querySelector('#career-fairs-section'),
  notice: document.querySelector('#notice'),
};

let configuration;
let snapshot;
let selectedFilter = '全部';
let selectedScheduleView = 'pending';
let selectedScheduleCategory = 'all';
let deferredInstallPrompt;
let pushPlusEnabled = false;
let webPushEnabled = false;

void initialize();

async function initialize() {
  registerInteractions();
  if ('serviceWorker' in navigator) void navigator.serviceWorker.register('./sw.js');
  try {
    const paired = readPairingFragment();
    if (paired) {
      await databasePut('configuration', paired);
      configuration = paired;
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      showNotice('配对成功，正在下载快照');
    } else {
      configuration = await databaseGet('configuration');
    }
    snapshot = await databaseGet('snapshot');
    renderShell();
    if (configuration && navigator.onLine) await refreshSnapshot();
    scheduleRefresh();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : '无法打开手机视图', true);
    renderShell();
  }
}

function registerInteractions() {
  elements.refresh.addEventListener('click', () => void refreshSnapshot());
  elements.recordSearch.addEventListener('input', renderApplications);
  elements.fairSearch.addEventListener('input', renderCareerFairs);
  elements.statusFilters.addEventListener('click', event => {
    const button = event.target.closest('button[data-status]');
    if (!button) return;
    selectedFilter = button.dataset.status;
    renderFilters();
    renderApplications();
  });
  document.querySelector('.section-tabs').addEventListener('click', event => {
    const button = event.target.closest('button[data-section]');
    if (!button) return;
    document.querySelectorAll('.section-tabs button').forEach(item => item.classList.toggle('is-active', item === button));
    const selected = button.dataset.section;
    elements.applicationsSection.hidden = selected !== 'applications';
    elements.schedulesSection.hidden = selected !== 'schedules';
    elements.careerFairsSection.hidden = selected !== 'career-fairs';
    if (selected === 'schedules') renderSchedules();
  });
  document.querySelector('.schedule-view-tabs').addEventListener('click', event => {
    const button = event.target.closest('button[data-schedule-view]');
    if (!button) return;
    selectedScheduleView = button.dataset.scheduleView;
    renderSchedules();
  });
  elements.scheduleCategoryTabs.addEventListener('click', event => {
    const button = event.target.closest('button[data-schedule-category]');
    if (!button) return;
    selectedScheduleCategory = button.dataset.scheduleCategory;
    renderSchedules();
  });
  window.addEventListener('online', () => void refreshSnapshot());
  window.addEventListener('offline', () => updateSyncCaption('当前离线，显示本机最后缓存'));
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    elements.install.hidden = false;
  });
  elements.install.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = undefined;
    elements.install.hidden = true;
  });
  elements.notification.addEventListener('click', openReminderDialog);
  elements.reminderBackdrop.addEventListener('click', closeReminderDialog);
  elements.reminderClose.addEventListener('click', closeReminderDialog);
  elements.pushPlusSave.addEventListener('click', () => void savePushPlus());
  elements.pushPlusTest.addEventListener('click', () => void testPushPlus());
  elements.pushPlusDisable.addEventListener('click', () => void disablePushPlus());
  elements.webPushToggle.addEventListener('click', () => void toggleWebPush());
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !elements.reminderDialog.hidden) closeReminderDialog();
  });
}

function renderShell() {
  elements.unpaired.hidden = Boolean(configuration);
  elements.paired.hidden = !configuration;
  if (!configuration) return;
  void refreshReminderState();
  renderFilters();
  renderSnapshot();
}

function openReminderDialog() {
  elements.reminderDialog.hidden = false;
  document.body.classList.add('has-dialog');
  void refreshReminderState();
  elements.reminderClose.focus();
}

function closeReminderDialog() {
  elements.reminderDialog.hidden = true;
  document.body.classList.remove('has-dialog');
  elements.notification.focus();
}

async function refreshReminderState() {
  elements.notification.hidden = !configuration;
  if (!configuration) return;
  const [pushPlus, webPush] = await Promise.all([refreshPushPlusState(), refreshWebPushState()]);
  pushPlusEnabled = pushPlus;
  webPushEnabled = webPush;
  const enabled = pushPlusEnabled || webPushEnabled;
  elements.notification.textContent = enabled ? '手机提醒 · 已开' : '手机提醒';
  elements.notification.setAttribute('aria-pressed', String(enabled));
  elements.notification.title = enabled
    ? '管理国内 App 提醒和浏览器提醒'
    : '开启提前 24 小时和 5 小时的手机提醒';
}

async function refreshPushPlusState() {
  setChannelStatus(elements.pushPlusStatus, '正在读取状态…');
  try {
    const response = await fetch(pushPlusConfigUrl(), {
      cache: 'no-store',
      headers: { authorization: `Bearer ${configuration.readToken}` },
    });
    if (!response.ok) throw new Error(await apiError(response, '无法读取国内手机提醒状态'));
    const state = await response.json();
    const enabled = state?.enabled === true;
    setChannelStatus(
      elements.pushPlusStatus,
      enabled ? `已开启 · token ${state.tokenHint || '已安全保存'}` : '未开启 · 安装 App 后填写 token',
      enabled ? 'enabled' : '',
    );
    elements.pushPlusSave.textContent = enabled ? '更新 token' : '保存并开启';
    elements.pushPlusToken.placeholder = enabled ? '输入新 token 可更换' : '从 PushPlus 个人中心复制';
    elements.pushPlusTest.hidden = !enabled;
    elements.pushPlusDisable.hidden = !enabled;
    return enabled;
  } catch (error) {
    setChannelStatus(
      elements.pushPlusStatus,
      error instanceof Error ? error.message : '无法读取国内手机提醒状态',
      'unavailable',
    );
    return false;
  }
}

async function refreshWebPushState() {
  const supportProblem = notificationSupportProblem();
  if (supportProblem) {
    setChannelStatus(elements.webPushStatus, supportProblem, 'unavailable');
    elements.webPushToggle.disabled = true;
    elements.webPushToggle.textContent = '此浏览器不可用';
    return false;
  }
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    const enabled = Boolean(subscription && Notification.permission === 'granted');
    setChannelStatus(
      elements.webPushStatus,
      enabled ? '已开启 · 由当前浏览器接收' : Notification.permission === 'denied'
        ? '系统已拒绝此网站的通知权限'
        : '未开启 · 可作为备用通道',
      enabled ? 'enabled' : Notification.permission === 'denied' ? 'unavailable' : '',
    );
    elements.webPushToggle.disabled = Notification.permission === 'denied';
    elements.webPushToggle.textContent = enabled ? '关闭浏览器提醒' : '开启浏览器提醒';
    return enabled;
  } catch {
    setChannelStatus(elements.webPushStatus, '浏览器提醒服务尚未就绪，请刷新后重试', 'unavailable');
    elements.webPushToggle.disabled = true;
    return false;
  }
}

async function toggleWebPush() {
  if (!configuration) return;
  const supportProblem = notificationSupportProblem();
  if (supportProblem) {
    showNotice(supportProblem, true);
    return;
  }
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription && Notification.permission === 'granted') {
    await disableWebPush(subscription);
    return;
  }
  await enableWebPush();
}

async function enableWebPush() {
  if (!configuration) return;
  const supportProblem = notificationSupportProblem();
  if (supportProblem) {
    showNotice(supportProblem, true);
    return;
  }
  elements.webPushToggle.disabled = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'denied') throw new Error('手机通知权限已关闭，请到系统设置中允许“求职进度”的通知');
    if (permission !== 'granted') throw new Error('尚未获得手机通知权限，请再次点击并选择“允许”');
    const keyResponse = await fetch(`${configuration.serverUrl}/api/push/public-key`, { cache: 'no-store' });
    if (!keyResponse.ok) throw new Error('无法读取手机推送配置');
    const { publicKey } = await keyResponse.json();
    if (typeof publicKey !== 'string') throw new Error('手机推送配置格式无效');
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription()
      ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: fromBase64Url(publicKey),
      });
    const response = await fetch(
      `${configuration.serverUrl}/api/push-subscriptions/${encodeURIComponent(configuration.deviceId)}`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${configuration.readToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(subscription.toJSON()),
      },
    );
    if (!response.ok) throw new Error('云端拒绝保存手机推送订阅');
    showNotice('浏览器提醒已开启；不会影响国内 App 提醒和桌面提醒');
  } catch (error) {
    showNotice(error instanceof Error ? error.message : '无法开启手机提醒', true);
  } finally {
    elements.webPushToggle.disabled = false;
    await refreshReminderState();
  }
}

async function disableWebPush(subscription) {
  elements.webPushToggle.disabled = true;
  try {
    const response = await fetch(
      `${configuration.serverUrl}/api/push-subscriptions/${encodeURIComponent(configuration.deviceId)}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${configuration.readToken}` },
      },
    );
    if (!response.ok) throw new Error('云端拒绝关闭手机推送订阅');
    await subscription.unsubscribe();
    showNotice('浏览器提醒已关闭；国内 App 提醒和桌面提醒保持原设置');
  } catch (error) {
    showNotice(error instanceof Error ? error.message : '无法关闭手机提醒', true);
  } finally {
    elements.webPushToggle.disabled = false;
    await refreshReminderState();
  }
}

async function savePushPlus() {
  const token = elements.pushPlusToken.value.trim();
  if (!token) {
    showNotice(pushPlusEnabled ? '请输入新的 PushPlus token 后再更新' : '请先粘贴 PushPlus token', true);
    elements.pushPlusToken.focus();
    return;
  }
  elements.pushPlusSave.disabled = true;
  try {
    const response = await fetch(pushPlusConfigUrl(), {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${configuration.readToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) throw new Error(await apiError(response, '无法开启国内手机提醒'));
    elements.pushPlusToken.value = '';
    showNotice('国内 App 提醒已开启；请发送一条测试提醒确认手机通知权限');
    await refreshReminderState();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : '无法开启国内手机提醒', true);
  } finally {
    elements.pushPlusSave.disabled = false;
  }
}

async function testPushPlus() {
  elements.pushPlusTest.disabled = true;
  try {
    const response = await fetch(pushPlusConfigUrl(), {
      method: 'POST',
      headers: { authorization: `Bearer ${configuration.readToken}` },
    });
    if (!response.ok) throw new Error(await apiError(response, '测试提醒发送失败'));
    showNotice('测试提醒已发送，请查看 PushPlus App 的系统通知');
  } catch (error) {
    showNotice(error instanceof Error ? error.message : '测试提醒发送失败', true);
  } finally {
    elements.pushPlusTest.disabled = false;
  }
}

async function disablePushPlus() {
  if (!pushPlusEnabled) return;
  if (typeof window.confirm === 'function' && !window.confirm('关闭国内 App 提醒并删除已保存的 token？')) return;
  elements.pushPlusDisable.disabled = true;
  try {
    const response = await fetch(pushPlusConfigUrl(), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${configuration.readToken}` },
    });
    if (!response.ok) throw new Error(await apiError(response, '无法关闭国内手机提醒'));
    showNotice('国内 App 提醒已关闭；浏览器提醒和桌面提醒保持原设置');
    await refreshReminderState();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : '无法关闭国内手机提醒', true);
  } finally {
    elements.pushPlusDisable.disabled = false;
  }
}

function pushPlusConfigUrl() {
  return `${configuration.serverUrl}/api/pushplus-config/${encodeURIComponent(configuration.deviceId)}`;
}

async function apiError(response, fallback) {
  try {
    const value = await response.json();
    if (typeof value?.error === 'string' && value.error.trim()) return value.error.trim();
  } catch {
    // Non-JSON responses use the bounded fallback below.
  }
  return `${fallback}（HTTP ${response.status}）`;
}

function setChannelStatus(element, text, state = '') {
  element.textContent = text;
  element.className = `channel-status${state ? ` is-${state}` : ''}`;
}

function notificationSupportProblem() {
  if (isAppleMobileDevice() && !isStandaloneApp()) {
    return 'iPhone/iPad 请先在 Safari 点“分享”→“添加到主屏幕”，再从桌面图标打开并开启提醒';
  }
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    const missing = [];
    if (!('Notification' in window)) missing.push('系统通知');
    if (!('serviceWorker' in navigator)) missing.push('后台服务');
    if (!('PushManager' in window)) missing.push('网页推送');
    return `当前浏览器缺少${missing.join('、')}能力；可使用上方国内 App 提醒，无需更换浏览器或开启 VPN`;
  }
  return '';
}

function isAppleMobileDevice() {
  return /iPad|iPhone|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function renderSnapshot() {
  const records = snapshot?.applications ?? [];
  const fairs = snapshot?.careerFairs ?? [];
  elements.total.textContent = String(records.length);
  elements.active.textContent = String(records.filter(record => ACTIVE_STATUSES.has(record.status)).length);
  elements.upcoming.textContent = String(upcomingScheduleItems(records).length);
  if (snapshot?.generatedAt) {
    updateSyncCaption(`云端最后更新：${formatDateTime(snapshot.generatedAt)}`);
  } else {
    updateSyncCaption(navigator.onLine ? '等待桌面端上传首份快照' : '当前离线，尚无本机缓存');
  }
  renderApplications();
  renderSchedules();
  renderCareerFairs();
}

function renderFilters() {
  elements.statusFilters.replaceChildren(...FILTERS.map(status => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.status = status;
    button.className = selectedFilter === status ? 'is-active' : '';
    button.textContent = status;
    return button;
  }));
}

function renderApplications() {
  const query = elements.recordSearch.value.trim().toLocaleLowerCase();
  const records = [...(snapshot?.applications ?? [])]
    .filter(record => selectedFilter === '全部' || record.status === selectedFilter)
    .filter(record => !query || [record.companyName, record.jobTitle, record.location, record.notes, record.sourceSite]
      .some(value => String(value ?? '').toLocaleLowerCase().includes(query)))
    .sort((left, right) => recordTime(right) - recordTime(left));
  if (!records.length) return renderEmpty(elements.recordList, query ? '没有匹配的投递记录' : '暂无投递记录');
  elements.recordList.replaceChildren(...records.map(applicationCard));
}

function applicationCard(record) {
  const card = element('article', 'data-card application-card');
  const header = element('header');
  const identity = element('div');
  identity.append(element('strong', '', record.companyName), element('h2', '', record.jobTitle));
  header.append(identity, element('span', `status-badge status-${statusClass(record.status)}`, record.status));
  const meta = element('div', 'card-meta');
  meta.append(metaItem('投递', formatDateTime(record.appliedAt)), metaItem('地点', record.location || '未填写'));
  card.append(header, meta);
  const schedules = scheduleEntries(record.recruitmentSchedule);
  if (schedules.length) {
    const scheduleList = element('div', 'mobile-schedules');
    schedules.forEach(item => scheduleList.append(scheduleRow(item.label, item.entry)));
    card.append(scheduleList);
  }
  if (record.notes) card.append(element('p', 'card-note', record.notes));
  const links = element('footer', 'card-links');
  if (validHttpUrl(record.sourceUrl)) links.append(link('岗位页面', record.sourceUrl));
  if (links.children.length) card.append(links);
  return card;
}

function renderCareerFairs() {
  const query = elements.fairSearch.value.trim().toLocaleLowerCase();
  const now = Date.now();
  const fairs = [...(snapshot?.careerFairs ?? [])]
    .filter(fair => !query || [fair.name, fair.location, fair.organizer, fair.targetCompanies, fair.targetRoles, fair.notes]
      .some(value => String(value ?? '').toLocaleLowerCase().includes(query)))
    .sort((left, right) => {
      const leftTime = Date.parse(left.startsAt);
      const rightTime = Date.parse(right.startsAt);
      const leftUpcoming = fairEnd(left) >= now;
      const rightUpcoming = fairEnd(right) >= now;
      if (leftUpcoming !== rightUpcoming) return leftUpcoming ? -1 : 1;
      return leftUpcoming ? leftTime - rightTime : rightTime - leftTime;
    });
  if (!fairs.length) return renderEmpty(elements.fairList, query ? '没有匹配的招聘会' : '暂无招聘会');
  elements.fairList.replaceChildren(...fairs.map(careerFairCard));
}

function careerFairCard(fair) {
  const card = element('article', 'data-card fair-card');
  const header = element('header');
  const identity = element('div');
  identity.append(element('span', 'eyebrow', fair.mode), element('h2', '', fair.name));
  header.append(identity, element('span', 'status-badge', fair.status));
  card.append(header);
  const meta = element('div', 'card-meta');
  meta.append(metaItem('时间', formatDateTime(fair.startsAt)), metaItem('地点', fair.location || '未填写'));
  card.append(meta);
  if (fair.targetCompanies) card.append(detailLine('目标公司', fair.targetCompanies));
  if (fair.targetRoles) card.append(detailLine('目标岗位', fair.targetRoles));
  if (fair.preparation) card.append(detailLine('准备事项', fair.preparation));
  if (fair.notes) card.append(element('p', 'card-note', fair.notes));
  if (validHttpUrl(fair.eventUrl)) {
    const footer = element('footer', 'card-links');
    footer.append(link('招聘会页面', fair.eventUrl));
    card.append(footer);
  }
  return card;
}

function renderSchedules() {
  const records = snapshot?.applications ?? [];
  const now = Date.now();
  const pending = upcomingScheduleItems(records, now);
  const completed = completedScheduleItems(records);
  elements.scheduleTotal.textContent = `${pending.length} 项待处理`;
  elements.schedulePendingCount.textContent = String(pending.length);
  elements.scheduleCompletedCount.textContent = String(completed.length);
  document.querySelectorAll('.schedule-view-tabs button').forEach(button => {
    button.classList.toggle('is-active', button.dataset.scheduleView === selectedScheduleView);
  });
  elements.scheduleCategoryTabs.hidden = selectedScheduleView !== 'pending';
  elements.scheduleCategoryTabs.querySelectorAll('button[data-schedule-category]').forEach(button => {
    const category = button.dataset.scheduleCategory;
    button.classList.toggle('is-active', category === selectedScheduleCategory);
    const count = button.querySelector('span');
    if (count) count.textContent = String(filterScheduleItems(pending, category).length);
  });
  const items = selectedScheduleView === 'completed'
    ? completed
    : filterScheduleItems(pending, selectedScheduleCategory);
  if (!items.length) {
    const empty = selectedScheduleView === 'completed'
      ? '还没有标记完成的安排'
      : selectedScheduleCategory === 'all'
        ? '还没有即将开始或截止的安排'
        : '当前分类暂无近期安排';
    return renderEmpty(elements.scheduleList, empty);
  }
  elements.scheduleList.replaceChildren(...items.map((item, index) => scheduleCard(
    item,
    selectedScheduleView === 'pending' && index === 0,
    now,
  )));
}

function scheduleCard(item, isNext, now) {
  const completed = Boolean(item.completedAt);
  const card = element('article', `schedule-ticket${isNext ? ' is-next' : ''}${completed ? ' is-completed' : ''}`);
  const date = new Date(item.eventAt);
  const dateBlock = element('time', 'schedule-date');
  dateBlock.dateTime = item.scheduledAt;
  dateBlock.append(
    element('span', '', `${String(date.getMonth() + 1).padStart(2, '0')}月`),
    element('strong', '', String(date.getDate()).padStart(2, '0')),
    element('small', '', new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date)),
  );
  const content = element('div', 'schedule-ticket-content');
  const kicker = element('div', 'schedule-ticket-kicker');
  kicker.append(
    element('span', '', isNext ? '下一项' : completed ? '已完成' : '随后'),
    element('strong', '', scheduleDisplayLabel(item.label, item)),
  );
  content.append(kicker, element('h3', '', item.companyName), element('p', '', item.jobTitle));
  const timing = element('div', 'schedule-ticket-timing');
  timing.append(element('strong', '', formatDateTime(item.scheduledAt)));
  timing.append(element('span', '', completed
    ? `完成于 ${formatDateTime(item.completedAt)}`
    : countdownLabel(item, now)));
  content.append(timing);
  if (validHttpUrl(item.url)) {
    const actions = element('footer', 'schedule-ticket-actions');
    actions.append(link('打开安排链接', item.url));
    content.append(actions);
  }
  card.append(dateBlock, content);
  return card;
}

function countdownLabel(item, now) {
  const minutes = Math.max(1, Math.ceil((item.eventAt - now) / 60_000));
  const value = minutes < 60
    ? `${minutes} 分钟`
    : minutes < 2_880 ? `${Math.ceil(minutes / 60)} 小时` : `${Math.ceil(minutes / 1_440)} 天`;
  const action = item.timeKind === 'deadline' ? '截止' : item.timeKind === 'start' ? '开始' : '到时';
  return `${value}后${action}`;
}

async function refreshSnapshot() {
  if (!configuration) return;
  if (!navigator.onLine) {
    updateSyncCaption('当前离线，显示本机最后缓存');
    return;
  }
  elements.refresh.disabled = true;
  elements.refresh.classList.add('is-loading');
  updateSyncCaption('正在读取云端加密快照…');
  try {
    const response = await fetch(`${configuration.serverUrl}/api/snapshots/${encodeURIComponent(configuration.deviceId)}`, {
      headers: { authorization: `Bearer ${configuration.readToken}` },
      cache: 'no-store',
    });
    if (response.status === 404) {
      updateSyncCaption('等待桌面端上传首份快照');
      return;
    }
    if (!response.ok) throw new Error(`读取云端快照失败（HTTP ${response.status}）`);
    const envelope = await response.json();
    const next = await decryptEnvelope(envelope, configuration);
    if (!snapshot || next.revision >= snapshot.revision) {
      snapshot = next;
      await databasePut('snapshot', snapshot);
    }
    renderSnapshot();
  } catch (error) {
    updateSyncCaption(snapshot ? '云端暂不可用，显示本机最后缓存' : '云端暂不可用，且本机尚无缓存');
    showNotice(error instanceof Error ? error.message : '刷新失败', true);
  } finally {
    elements.refresh.disabled = false;
    elements.refresh.classList.remove('is-loading');
  }
}

async function decryptEnvelope(envelope, config) {
  if (
    !envelope || envelope.schemaVersion !== 1 || envelope.deviceId !== config.deviceId
    || !Number.isSafeInteger(envelope.revision) || envelope.algorithm !== 'A256GCM'
  ) throw new Error('云端快照格式无效');
  const keyBytes = fromBase64Url(config.key);
  if (keyBytes.length !== 32) throw new Error('手机配对密钥无效');
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const iv = fromBase64Url(envelope.iv);
  const ciphertext = fromBase64Url(envelope.ciphertext);
  const authTag = fromBase64Url(envelope.authTag);
  const encrypted = new Uint8Array(ciphertext.length + authTag.length);
  encrypted.set(ciphertext);
  encrypted.set(authTag, ciphertext.length);
  const aad = new TextEncoder().encode(`job-application-helper-mobile:${config.deviceId}:${envelope.revision}`);
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, encrypted);
  } catch {
    throw new Error('快照解密失败，请从桌面端重新扫码配对');
  }
  const value = JSON.parse(new TextDecoder().decode(plaintext));
  if (value?.schemaVersion !== 1 || !Array.isArray(value.applications) || !Array.isArray(value.careerFairs)) {
    throw new Error('解密后的快照格式无效');
  }
  return value;
}

function readPairingFragment() {
  const match = /^#pair=([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (!match) return undefined;
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(fromBase64Url(match[1])));
  } catch {
    throw new Error('配对链接无效');
  }
  if (
    value?.v !== 1 || typeof value.serverUrl !== 'string' || typeof value.deviceId !== 'string'
    || typeof value.readToken !== 'string' || value.readToken.length < 16
    || typeof value.key !== 'string' || fromBase64Url(value.key).length !== 32
  ) throw new Error('配对链接缺少必要信息');
  const serverUrl = new URL(value.serverUrl);
  const local = ['localhost', '127.0.0.1', '::1'].includes(serverUrl.hostname);
  if (serverUrl.protocol !== 'https:' && !(local && serverUrl.protocol === 'http:')) throw new Error('配对服务必须使用 HTTPS');
  return { ...value, serverUrl: serverUrl.toString().replace(/\/$/, '') };
}

function scheduleRefresh() {
  window.setInterval(() => {
    if (configuration && navigator.onLine && document.visibilityState === 'visible') void refreshSnapshot();
  }, 30_000);
}

function scheduleRow(label, entry) {
  const row = element('div', `schedule-row${entry.completedAt ? ' is-completed' : ''}`);
  const timeLabel = scheduleDisplayLabel(label, entry);
  row.append(element('strong', '', entry.completedAt ? `${timeLabel} · 已完成` : timeLabel), element('span', '', entry.scheduledAt ? formatDateTime(entry.scheduledAt) : '时间待定'));
  if (validHttpUrl(entry.url)) row.append(link('打开', entry.url));
  return row;
}

function metaItem(label, value) {
  const item = element('div');
  item.append(element('span', '', label), element('strong', '', value));
  return item;
}

function detailLine(label, value) {
  const line = element('p', 'detail-line');
  line.append(element('strong', '', label), document.createTextNode(value));
  return line;
}

function link(label, url) {
  const anchor = element('a', '', label);
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noreferrer noopener';
  return anchor;
}

function renderEmpty(container, message) {
  container.replaceChildren(element('div', 'list-empty', message));
}

function element(tagName, className = '', text = '') {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function statusClass(status) {
  return ({ '待投递': 'pending', '已投递': 'submitted', '笔试/测评': 'assessment', '面试中': 'interview', offer: 'offer' })[status] ?? 'closed';
}

function recordTime(record) {
  return Math.max(...[record.appliedAt, record.createdAt, record.updatedAt].map(value => Date.parse(value || '') || 0));
}

function fairEnd(fair) {
  return Date.parse(fair.endsAt || fair.startsAt || '') || 0;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '未填写';
  const includesTime = String(value).includes('T');
  return new Intl.DateTimeFormat('zh-CN', includesTime
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
    : { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function validHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function updateSyncCaption(text) {
  elements.syncCaption.textContent = text;
}

function showNotice(message, isError = false) {
  elements.notice.textContent = message;
  elements.notice.classList.toggle('is-error', isError);
  elements.notice.hidden = false;
  window.setTimeout(() => { elements.notice.hidden = true; }, 3_500);
}

function fromBase64Url(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value).length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function databaseGet(key) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

async function databasePut(key, value) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(value, key);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
  });
}
