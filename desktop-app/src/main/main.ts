import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAX_BACKUP_BYTES } from '../../../src/shared/backup.ts';
import {
  DESKTOP_CHANNELS,
  type DesktopCareerFairInput,
  type DesktopImportResult,
  type DesktopMailReviewDecisionInput,
  type DesktopMobileSyncSetupInput,
  type DesktopRecordFavoriteInput,
  type DesktopRecordInput,
  type DesktopResult,
  type DesktopWebDavInput,
} from '../shared/contracts.ts';
import { DesktopController } from './desktopController.ts';
import { DesktopStore } from './desktopStore.ts';
import { DesktopLocalSyncService } from './desktopLocalSyncService.ts';
import { DesktopSyncService } from './desktopSyncService.ts';
import { ElectronSecretCodec } from './electronSecrets.ts';
import { MobileSnapshotSyncService } from './mobileSnapshotSyncService.ts';
import { DesktopMailInboxService } from './desktopMailInboxService.ts';
import { DesktopNativeMailClient } from './desktopNativeMailClient.ts';
import { DesktopReminderService } from './desktopReminderService.ts';
import {
  recruitmentReminderMessage,
  type RecruitmentReminder,
} from '../domain/reminders.ts';

const currentDir = dirname(fileURLToPath(import.meta.url));
const rendererHtml = join(currentDir, '../renderer/index.html');
const preloadScript = join(currentDir, 'preload.cjs');
const rendererUrl = pathToFileURL(rendererHtml).toString();
const smokeCapturePath = process.env.JOB_HELPER_DESKTOP_SMOKE_CAPTURE?.trim();
let mainWindow: BrowserWindow | null = null;
let desktopController: DesktopController | null = null;
let desktopReminderService: DesktopReminderService | null = null;
let tray: Tray | null = null;
let quitFlushStarted = false;
const hasSingleInstanceLock = Boolean(smokeCapturePath) || app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) app.quit();
app.on('second-instance', () => {
  if (app.isReady()) createWindow();
});

function resultHandler<TArgs extends unknown[], TResult>(
  operation: (...args: TArgs) => Promise<TResult>,
) {
  return async (event: IpcMainInvokeEvent, ...args: TArgs): Promise<DesktopResult<TResult>> => {
    try {
      assertTrustedSender(event);
      return { success: true, data: await operation(...args) };
    } catch (error) {
      console.error('桌面端操作失败', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '桌面端操作失败',
      };
    }
  };
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url ?? '';
  if (!senderUrl.startsWith('file:')) throw new Error('拒绝来自未知页面的请求');
}

function compactTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

async function readSelectedFile(extension: 'json' | 'csv'): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: extension === 'json' ? '导入投递记录备份' : '导入投递记录 CSV',
    properties: ['openFile'],
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  };
  const selected = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (selected.canceled || !selected.filePaths[0]) return null;
  const filePath = selected.filePaths[0];
  if ((await stat(filePath)).size > MAX_BACKUP_BYTES) throw new Error('导入文件超过 20 MiB 上限');
  return readFile(filePath, 'utf8');
}

async function saveExportFile(extension: 'json' | 'csv', content: string): Promise<string | null> {
  const defaultPath = `application-records-${compactTimestamp()}.${extension}`;
  const options: SaveDialogOptions = {
    title: extension === 'json' ? '导出桌面端 JSON 备份' : '导出投递记录 CSV',
    defaultPath,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  };
  const selected = mainWindow
    ? await dialog.showSaveDialog(mainWindow, options)
    : await dialog.showSaveDialog(options);
  if (selected.canceled || !selected.filePath) return null;
  await writeFile(selected.filePath, content, 'utf8');
  return selected.filePath;
}

function registerIpc(controller: DesktopController): void {
  ipcMain.handle(DESKTOP_CHANNELS.getState, resultHandler(() => controller.getState()));
  ipcMain.handle(
    DESKTOP_CHANNELS.saveRecord,
    resultHandler((input: DesktopRecordInput) => controller.saveRecord(input)),
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.deleteRecord,
    resultHandler((id: string) => controller.deleteRecord(id)),
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.setRecordFavorite,
    resultHandler((input: DesktopRecordFavoriteInput) => controller.setRecordFavorite(input)),
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.saveCareerFair,
    resultHandler((input: DesktopCareerFairInput) => controller.saveCareerFair(input)),
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.deleteCareerFair,
    resultHandler((id: string) => controller.deleteCareerFair(id)),
  );
  ipcMain.handle(DESKTOP_CHANNELS.importJson, resultHandler(async (): Promise<DesktopImportResult> => {
    const raw = await readSelectedFile('json');
    if (raw === null) return { state: await controller.getState(), imported: 0, warnings: [], cancelled: true };
    return controller.importJson(raw);
  }));
  ipcMain.handle(DESKTOP_CHANNELS.exportJson, resultHandler(async () => {
    const filename = await saveExportFile('json', await controller.exportJson());
    return filename ? { filename } : { cancelled: true };
  }));
  ipcMain.handle(DESKTOP_CHANNELS.importCsv, resultHandler(async (): Promise<DesktopImportResult> => {
    const raw = await readSelectedFile('csv');
    if (raw === null) return { state: await controller.getState(), imported: 0, warnings: [], cancelled: true };
    return controller.importCsv(raw);
  }));
  ipcMain.handle(DESKTOP_CHANNELS.exportCsv, resultHandler(async () => {
    const filename = await saveExportFile('csv', await controller.exportCsv());
    return filename ? { filename } : { cancelled: true };
  }));
  ipcMain.handle(
    DESKTOP_CHANNELS.saveWebDav,
    resultHandler((input: DesktopWebDavInput) => controller.saveWebDav(input)),
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.testWebDav,
    resultHandler((input: DesktopWebDavInput) => controller.testWebDav(input)),
  );
  ipcMain.handle(DESKTOP_CHANNELS.syncNow, resultHandler(() => controller.syncNow()));
  ipcMain.handle(
    DESKTOP_CHANNELS.resolveConflict,
    resultHandler((choice: 'local' | 'remote') => controller.resolveConflict(choice)),
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.setupMobileSync,
    resultHandler((input: DesktopMobileSyncSetupInput) => controller.setupMobileSync(input)),
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.setMobileSyncEnabled,
    resultHandler((enabled: boolean) => controller.setMobileSyncEnabled(enabled)),
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.setDesktopReminderEnabled,
    resultHandler(async (enabled: boolean) => {
      const state = await controller.setDesktopReminderEnabled(enabled);
      if (enabled) await desktopReminderService?.checkNow();
      return state;
    }),
  );
  ipcMain.handle(DESKTOP_CHANNELS.syncMobileNow, resultHandler(() => controller.syncMobileNow()));
  ipcMain.handle(DESKTOP_CHANNELS.getMobilePairing, resultHandler(() => controller.getMobilePairing()));
  ipcMain.handle(DESKTOP_CHANNELS.scanMail, resultHandler(() => controller.scanMail()));
  ipcMain.handle(
    DESKTOP_CHANNELS.confirmMailReview,
    resultHandler((input: DesktopMailReviewDecisionInput) => controller.confirmMailReview(input)),
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.ignoreMailReview,
    resultHandler((reviewId: string) => controller.ignoreMailReview(reviewId)),
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.ignoreMailReviews,
    resultHandler((reviewIds: string[]) => controller.ignoreMailReviews(reviewIds)),
  );
  ipcMain.handle(DESKTOP_CHANNELS.openExternal, resultHandler(async (rawUrl: string) => {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('只允许打开 HTTP 或 HTTPS 链接');
    await shell.openExternal(url.toString());
  }));
}

function createWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    title: '秋招投递管理器',
    backgroundColor: '#edf2f1',
    show: false,
    webPreferences: {
      preload: preloadScript,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl !== rendererUrl) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', event => {
    if (quitFlushStarted || smokeCapturePath) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  void mainWindow.loadFile(rendererHtml).then(async () => {
    if (!smokeCapturePath || !mainWindow) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
    const image = await mainWindow.webContents.capturePage();
    await mkdir(dirname(smokeCapturePath), { recursive: true });
    await writeFile(smokeCapturePath, image.toPNG());
    mainWindow.destroy();
    app.quit();
  });
}

function createTray(): void {
  if (tray || smokeCapturePath) return;
  tray = new Tray(join(app.getAppPath(), 'build', 'icon.png'));
  tray.setToolTip('秋招投递管理器');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开秋招投递管理器', click: createWindow },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', createWindow);
}

function showRecruitmentReminder(reminder: RecruitmentReminder): void {
  if (!Notification.isSupported()) throw new Error('当前系统不支持桌面通知');
  const message = recruitmentReminderMessage(reminder);
  const notification = new Notification({ title: message.title, body: message.body });
  notification.on('click', createWindow);
  notification.show();
}

app.setAppUserModelId('com.jwk.jobapplicationhelper.desktop');
if (smokeCapturePath) app.setPath('userData', join(dirname(smokeCapturePath), 'desktop-smoke-user-data'));
void app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  const store = new DesktopStore(join(app.getPath('userData'), 'desktop-data.json'));
  const secrets = new ElectronSecretCodec();
  const syncService = new DesktopSyncService(store, secrets);
  const localSyncService = new DesktopLocalSyncService();
  const mobileSnapshotSyncService = new MobileSnapshotSyncService(store, secrets);
  const mailInboxService = new DesktopMailInboxService(new DesktopNativeMailClient());
  desktopReminderService = new DesktopReminderService(
    async () => (await store.read()).records,
    join(app.getPath('userData'), 'desktop-reminder-state.json'),
    showRecruitmentReminder,
    Date.now,
    async () => (await store.read()).desktopReminder?.enabled ?? true,
  );
  desktopController = new DesktopController(
    store,
    syncService,
    localSyncService,
    mobileSnapshotSyncService,
    mailInboxService,
    Notification.isSupported(),
  );
  registerIpc(desktopController);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  void desktopController.start(state => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(DESKTOP_CHANNELS.stateChanged, state);
    }
  }).then(() => desktopReminderService?.start()).finally(() => {
    createTray();
    createWindow();
  });
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (smokeCapturePath) app.quit();
});

app.on('before-quit', event => {
  if (quitFlushStarted) {
    desktopController?.stop();
    desktopReminderService?.stop();
    tray?.destroy();
    return;
  }
  event.preventDefault();
  quitFlushStarted = true;
  void Promise.resolve(desktopController?.flushMobileSnapshot())
    .catch(error => console.error('退出前手机快照补充同步失败', error))
    .finally(() => {
      desktopController?.stop();
      desktopReminderService?.stop();
      app.quit();
    });
});
