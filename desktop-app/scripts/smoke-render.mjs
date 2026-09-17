import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(desktopRoot, '../.artifacts');
const outputPath = join(outputDirectory, 'desktop-ui-smoke.png');
const recordFormOutputPath = join(outputDirectory, 'desktop-record-schedule-form-smoke.png');
const groupedOutputPath = join(outputDirectory, 'desktop-company-groups-smoke.png');
const careerFairOutputPath = join(outputDirectory, 'desktop-career-fairs-smoke.png');
const careerFairFormOutputPath = join(outputDirectory, 'desktop-career-fair-form-smoke.png');
const mobileSyncOutputPath = join(outputDirectory, 'desktop-mobile-sync-smoke.png');
const mailInboxOutputPath = join(outputDirectory, 'desktop-mail-inbox-smoke.png');
const favoritesOutputPath = join(outputDirectory, 'desktop-favorites-smoke.png');
const upcomingOutputPath = join(outputDirectory, 'desktop-upcoming-schedules-smoke.png');
const reminderOffOutputPath = join(outputDirectory, 'desktop-reminders-off-smoke.png');
const completedOutputPath = join(outputDirectory, 'desktop-completed-schedules-smoke.png');
const now = '2026-09-04T08:30:00.000Z';

const samples = [
  record('字节跳动', '前端开发工程师', '面试中', '北京', '2026-09-02', 'jobs.bytedance.com'),
  record('腾讯', '后台开发工程师', '笔试/测评', '深圳', '2026-09-01', 'join.qq.com'),
  record('小红书', '产品经理', '已投递', '上海', '2026-08-30', 'job.xiaohongshu.com'),
  record('米哈游', '数据分析师', 'offer', '上海', '2026-08-26', 'campus.mihoyo.com'),
  record('网易', '客户端开发', '待投递', '杭州', '2026-09-04', 'campus.163.com'),
];

const careerFairs = [{
  id: 'fair-campus-autumn',
  name: '西北工业大学 2027 届秋季大型双选会',
  status: '已报名',
  startsAt: '2026-09-12T09:00',
  endsAt: '2026-09-12T16:00',
  mode: '线下',
  location: '长安校区启真楼一楼',
  organizer: '学生就业创业指导服务中心',
  registrationDeadline: '2026-09-11T18:00',
  eventUrl: 'https://career.example.com/fair',
  targetCompanies: '华为、字节跳动、蔚来',
  targetRoles: 'Agent 开发工程师、算法工程师',
  preparation: '纸质简历 8 份、成绩单、作品集二维码',
  notes: '先去人工智能与软件企业展区，记录 HR 联系方式和后续网申入口。',
  createdAt: now,
  updatedAt: now,
}];

function record(companyName, jobTitle, status, location, appliedAt, sourceSite) {
  const id = `${companyName}-${jobTitle}`;
  const recruitmentSchedule = status === '面试中'
    ? {
        writtenTest: { scheduledAt: '2026-09-15T19:00', url: 'https://exam.example.com/written', timeKind: 'start' },
        assessment: { scheduledAt: '2026-09-16T14:30', url: 'https://exam.example.com/assessment', timeKind: 'deadline' },
        interviews: {
          ai: { scheduledAt: '2026-09-17T10:00', url: 'https://meeting.example.com/ai', timeKind: 'deadline' },
          first: { scheduledAt: '2026-09-18T10:00', url: 'https://meeting.example.com/first', timeKind: 'start' },
          second: { scheduledAt: '2026-09-20T14:00', url: 'https://meeting.example.com/second', timeKind: 'start' },
        },
      }
    : status === '笔试/测评'
      ? { assessment: { scheduledAt: '2026-09-17T14:00', url: 'https://exam.example.com/assessment', timeKind: 'deadline', completedAt: '2026-09-10T07:30:00.000Z' } }
      : undefined;
  return {
    id,
    companyName,
    jobTitle,
    sourceSite,
    sourceUrl: `https://${sourceSite}/job/${encodeURIComponent(jobTitle)}`,
    status,
    notes: status === '面试中' ? '一面已完成，等待二面安排' : '',
    recruitmentSchedule,
    appliedAt,
    location,
    events: [{
      id: `evt-${id}`,
      type: status === 'offer'
        ? 'offer'
        : status === '面试中'
          ? 'interview'
          : status === '笔试/测评'
            ? 'assessment_invite'
            : status === '待投递'
              ? 'application_created'
              : 'applied',
      occurredAt: appliedAt,
      timePrecision: 'date',
      source: 'manual',
      title: status,
      sourceKey: `manual:${id}:smoke`,
    }],
    createdAt: now,
    updatedAt: now,
  };
}

const smokeState = {
    records: samples,
    favoriteRecordIds: [samples[0].id, samples[2].id],
    careerFairs,
    desktopReminder: { enabled: true, supported: true },
    localSync: { status: 'synced', lastSyncedAt: now, recordCount: samples.length },
    mobileSync: { configured: true, enabled: true, serverUrl: 'https://mobile.example.com', status: 'synced', lastSyncedAt: now, revision: 100 },
    mailInbox: {
      status: 'idle',
      pendingCount: 2,
      lastScannedAt: now,
      accounts: [{ id: 'mail-1', provider: '163', emailAddress: 'candidate@163.com', displayName: '求职邮箱', connection: 'connected' }],
      reviews: [
        {
          id: 'review-ruijie', accountId: 'mail-1', messageId: '101', from: '锐捷校园招聘 <campus@example.com>',
          subject: '锐捷网络 AI面试邀约', receivedAt: now, summary: '请在规定时间内完成 AI 面试，点击邮件中的链接进入。',
          category: 'interview_invite', suggestedStage: 'ai', companyName: '锐捷网络',
          candidateRecordIds: [samples[0].id], extractedAt: '2026-09-12T19:00:00', actionUrl: 'https://meeting.example.com/ai', state: 'pending',
        },
        {
          id: 'review-inovance', accountId: 'mail-1', messageId: '102', from: '汇川技术招聘 <talent@example.com>',
          subject: '汇川技术2027届校园招聘测评通知', receivedAt: now, summary: '请于截止时间前完成人才测评。',
          category: 'assessment_invite', suggestedStage: 'assessment', companyName: '汇川技术',
          candidateRecordIds: [], deadlineAt: '2026-09-13T23:59:00', actionUrl: 'https://assessment.example.com/1', state: 'pending',
        },
      ],
    },
    sync: { status: 'synced', lastSyncedAt: now },
    webdav: {
      enabled: true,
      serverUrl: 'https://dav.example.com/',
      username: 'demo@example.com',
      passwordConfigured: true,
    },
};

ipcMain.handle('desktop:get-state', () => ({ success: true, data: smokeState }));
ipcMain.handle('desktop:set-desktop-reminder-enabled', (_event, enabled) => {
  smokeState.desktopReminder = { enabled: Boolean(enabled), supported: true };
  return { success: true, data: smokeState };
});

ipcMain.handle('desktop:get-mobile-pairing', () => ({
  success: true,
  data: {
    deviceId: 'smoke-device-123456',
    pairingUrl: 'https://mobile.example.com/#pair=eyJ2IjoxLCJkZXZpY2VJZCI6InNtb2tlLWRldmljZS0xMjM0NTYifQ',
  },
}));

void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#edf2f1',
    webPreferences: {
      preload: join(desktopRoot, 'dist/main/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  await window.loadFile(join(desktopRoot, 'dist/renderer/index.html'));
  await window.webContents.insertCSS('*, *::before, *::after { animation: none !important; transition: none !important; }');
  await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
  const image = await window.webContents.capturePage();
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputPath, image.toPNG());
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '编辑安排')
      ?.click();
  `);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
  await writeFile(recordFormOutputPath, (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`
    document.querySelector('.record-panel [aria-label="关闭"]')?.click();
  `);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('button')]
      .find(button => button.getAttribute('aria-label')?.startsWith('查看近期安排'))
      ?.click();
  `);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 350));
  const upcomingPanelStyle = await window.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.upcoming-panel');
    const style = panel ? getComputedStyle(panel) : null;
    const backdropStyle = panel?.parentElement ? getComputedStyle(panel.parentElement) : null;
    return style ? {
      backgroundColor: style.backgroundColor,
      opacity: style.opacity,
      animationName: style.animationName,
      backdropOpacity: backdropStyle?.opacity,
      backdropAnimation: backdropStyle?.animationName,
    } : null;
  })()`);
  await writeFile(upcomingOutputPath, (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('[role="tab"]')]
      .find(button => button.textContent?.includes('已完成'))
      ?.click();
  `);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  await writeFile(completedOutputPath, (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('[role="tab"]')]
      .find(button => button.textContent?.includes('待处理'))
      ?.click();
  `);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  await window.webContents.executeJavaScript(`
    document.querySelector('.upcoming-reminder-strip > button')?.click();
  `);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  await writeFile(reminderOffOutputPath, (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`
    document.querySelector('[aria-label="近期安排"] [aria-label="关闭"]')?.click();
  `);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '手机查看')
      ?.click();
  `);
  let mobileQrReady = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    mobileQrReady = await window.webContents.executeJavaScript(`Boolean(document.querySelector('.mobile-qr img'))`);
    if (mobileQrReady) break;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  const mobileQrText = await window.webContents.executeJavaScript(`document.querySelector('.mobile-qr')?.textContent?.trim() || ''`);
  const mobileSyncImage = await window.webContents.capturePage();
  await writeFile(mobileSyncOutputPath, mobileSyncImage.toPNG());
  await window.webContents.executeJavaScript(`
    document.querySelector('[aria-label="手机只读查看"] [aria-label="关闭"]')?.click();
  `);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '按公司查看')
      ?.click();
  `);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  const groupedImage = await window.webContents.capturePage();
  await writeFile(groupedOutputPath, groupedImage.toPNG());
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('button')]
      .find(button => button.getAttribute('aria-label')?.startsWith('招聘会 '))
      ?.click();
  `);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  const careerFairImage = await window.webContents.capturePage();
  await writeFile(careerFairOutputPath, careerFairImage.toPNG());
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === '＋ 新建招聘会')
      ?.click();
  `);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
  const panelStyle = await window.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.record-panel');
    const style = panel ? getComputedStyle(panel) : null;
    return style ? { backgroundColor: style.backgroundColor, opacity: style.opacity, animationName: style.animationName } : null;
  })()`);
  const careerFairFormImage = await window.webContents.capturePage();
  await writeFile(careerFairFormOutputPath, careerFairFormImage.toPNG());
  await window.webContents.executeJavaScript(`
    document.querySelector('.record-panel [aria-label="关闭"]')?.click();
  `);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('button')]
      .find(button => button.getAttribute('aria-label')?.startsWith('招聘邮箱 '))
      ?.click();
  `);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  const mailInboxImage = await window.webContents.capturePage();
  await writeFile(mailInboxOutputPath, mailInboxImage.toPNG());
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('button')]
      .find(button => button.getAttribute('aria-label')?.startsWith('特别关注 '))
      ?.click();
  `);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  const favoritesImage = await window.webContents.capturePage();
  await writeFile(favoritesOutputPath, favoritesImage.toPNG());
  console.log(outputPath);
  console.log(recordFormOutputPath);
  console.log(groupedOutputPath);
  console.log(careerFairOutputPath);
  console.log(careerFairFormOutputPath);
  console.log(mobileSyncOutputPath);
  console.log(mailInboxOutputPath);
  console.log(favoritesOutputPath);
  console.log(upcomingOutputPath);
  console.log(reminderOffOutputPath);
  console.log(completedOutputPath);
  console.log(JSON.stringify({ upcomingPanelStyle }));
  console.log(JSON.stringify({ mobileQrReady, mobileQrText }));
  console.log(JSON.stringify({ panelStyle }));
  window.destroy();
  app.quit();
});
