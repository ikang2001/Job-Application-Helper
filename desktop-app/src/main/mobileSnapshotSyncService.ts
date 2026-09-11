import { createCipheriv, randomBytes } from 'node:crypto';
import { createMobileSnapshot } from '../domain/mobileSnapshot.ts';
import {
  buildRecruitmentReminders,
  pushPlusReminderMessage,
  recruitmentReminderMessage,
} from '../domain/reminders.ts';
import type {
  DesktopMobilePairingInfo,
  DesktopMobileSyncSetupInput,
  DesktopMobileSyncState,
} from '../shared/contracts.ts';
import type {
  DesktopData,
  SecretCodec,
  StoredMobileSyncSettings,
} from './desktopStore.ts';
import { DesktopStore } from './desktopStore.ts';

const UPLOAD_DELAY_MS = 400;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

interface ProvisionResponse {
  deviceId: string;
  writeToken: string;
  readToken: string;
}

interface PendingSnapshot {
  records: DesktopData['records'];
  careerFairs: DesktopData['careerFairs'];
  settings: StoredMobileSyncSettings;
}

interface EncryptedMobileSnapshot {
  schemaVersion: 1;
  deviceId: string;
  revision: number;
  updatedAt: string;
  algorithm: 'A256GCM';
  iv: string;
  authTag: string;
  ciphertext: string;
}

interface EncryptedReminderPayload {
  algorithm: 'A256GCM';
  iv: string;
  authTag: string;
  ciphertext: string;
}

interface MobileReminderPlan {
  schemaVersion: 1;
  updatedAt: string;
  jobs: Array<{
    id: string;
    eventId: string;
    dueAt: string;
    eventAt: string;
    offsetMinutes: 1440 | 300;
    payload: EncryptedReminderPayload;
    notification: { title: string; body: string };
  }>;
}

export class MobileSnapshotSyncService {
  private status: DesktopMobileSyncState = disabledState();
  private listener?: (state: DesktopMobileSyncState) => void;
  private pending?: PendingSnapshot;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private lastRevision = 0;

  constructor(
    private readonly store: DesktopStore,
    private readonly secrets: SecretCodec,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  setStateListener(listener: (state: DesktopMobileSyncState) => void): void {
    this.listener = listener;
  }

  getState(settings?: StoredMobileSyncSettings): DesktopMobileSyncState {
    if (!settings) return disabledState();
    if (!settings.enabled) {
      return {
        configured: true,
        enabled: false,
        serverUrl: settings.serverUrl,
        status: 'disabled',
        lastSyncedAt: this.status.lastSyncedAt,
        revision: this.status.revision,
      };
    }
    return {
      ...this.status,
      configured: true,
      enabled: true,
      serverUrl: settings.serverUrl,
      status: this.status.status === 'disabled' ? 'idle' : this.status.status,
    };
  }

  async provision(data: DesktopData, input: DesktopMobileSyncSetupInput): Promise<DesktopData> {
    const serverUrl = normalizeServerUrl(input?.serverUrl);
    const setupToken = typeof input?.setupToken === 'string' ? input.setupToken.trim() : '';
    if (!setupToken) throw new Error('请输入手机同步服务设置码');
    const provisioned = await this.requestProvision(serverUrl, setupToken);
    const pairingKey = randomBytes(32).toString('base64url');
    const mobileSync: StoredMobileSyncSettings = {
      enabled: true,
      serverUrl,
      deviceId: provisioned.deviceId,
      encryptedWriteToken: this.secrets.encrypt(provisioned.writeToken),
      encryptedReadToken: this.secrets.encrypt(provisioned.readToken),
      encryptedPairingKey: this.secrets.encrypt(pairingKey),
    };
    const next = { ...data, mobileSync };
    await this.store.write(next);
    this.setStatus({
      configured: true,
      enabled: true,
      serverUrl,
      status: 'idle',
    });
    return next;
  }

  async setEnabled(data: DesktopData, enabled: boolean): Promise<DesktopData> {
    if (!data.mobileSync) throw new Error('请先建立手机安全配对');
    const next = { ...data, mobileSync: { ...data.mobileSync, enabled } };
    await this.store.write(next);
    if (!enabled) {
      this.pending = undefined;
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.setStatus(enabled ? {
      ...this.getState(next.mobileSync),
      status: 'idle',
      lastError: undefined,
    } : {
      ...this.getState(next.mobileSync),
      status: 'disabled',
      lastError: undefined,
    });
    return next;
  }

  getPairingInfo(settings?: StoredMobileSyncSettings): DesktopMobilePairingInfo {
    if (!settings) throw new Error('请先建立手机安全配对');
    const pairing = {
      v: 1,
      serverUrl: settings.serverUrl,
      deviceId: settings.deviceId,
      readToken: this.secrets.decrypt(settings.encryptedReadToken),
      key: this.secrets.decrypt(settings.encryptedPairingKey),
    };
    const encoded = Buffer.from(JSON.stringify(pairing), 'utf8').toString('base64url');
    return {
      deviceId: settings.deviceId,
      pairingUrl: `${settings.serverUrl}/#pair=${encoded}`,
    };
  }

  schedule(data: DesktopData): void {
    if (!data.mobileSync?.enabled) return;
    this.pending = snapshotInput(data, data.mobileSync);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain().catch(error => {
        console.error('手机快照后台同步失败；桌面数据已正常保留', error);
      });
    }, UPLOAD_DELAY_MS);
  }

  async syncNow(data: DesktopData): Promise<void> {
    if (!data.mobileSync?.enabled) throw new Error('手机查看尚未启用');
    this.pending = snapshotInput(data, data.mobileSync);
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.drain();
  }

  async flush(data?: DesktopData): Promise<void> {
    if (data?.mobileSync?.enabled) this.pending = snapshotInput(data, data.mobileSync);
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending && !this.running) return;
    await withTimeout(this.drain(), 3_000, '退出前手机快照同步超时');
  }

  private async drain(): Promise<void> {
    if (this.running) {
      await this.running;
      if (this.pending) return this.drain();
      return;
    }
    this.running = (async () => {
      let firstError: unknown;
      while (this.pending) {
        const current = this.pending;
        this.pending = undefined;
        try {
          await this.upload(current);
        } catch (error) {
          firstError ??= error;
          this.setStatus({
            configured: true,
            enabled: true,
            serverUrl: current.settings.serverUrl,
            status: 'error',
            lastSyncedAt: this.status.lastSyncedAt,
            lastError: error instanceof Error ? error.message : '手机快照同步失败',
            revision: this.status.revision,
          });
        }
      }
      if (firstError) throw firstError;
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async upload(input: PendingSnapshot): Promise<void> {
    const revision = Math.max(Date.now(), this.lastRevision + 1);
    this.lastRevision = revision;
    const updatedAt = new Date().toISOString();
    this.setStatus({
      configured: true,
      enabled: true,
      serverUrl: input.settings.serverUrl,
      status: 'syncing',
      lastSyncedAt: this.status.lastSyncedAt,
      revision: this.status.revision,
    });
    const snapshot = createMobileSnapshot(input.records, input.careerFairs, revision, updatedAt);
    const key = Buffer.from(this.secrets.decrypt(input.settings.encryptedPairingKey), 'base64url');
    if (key.length !== 32) throw new Error('手机配对密钥无效，请重新配对');
    const envelope = encryptSnapshot(snapshot, input.settings.deviceId, key);
    const authorization = `Bearer ${this.secrets.decrypt(input.settings.encryptedWriteToken)}`;
    const response = await fetchWithTimeout(this.fetcher, snapshotUrl(input.settings), {
      method: 'PUT',
      redirect: 'error',
      headers: {
        authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify(envelope),
    });
    if (!response.ok) throw new Error(await responseError(response, '云端拒绝保存手机快照'));
    const reminderPlan = createReminderPlan(
      input.records,
      input.settings.deviceId,
      key,
      updatedAt,
    );
    const reminderResponse = await fetchWithTimeout(this.fetcher, reminderPlanUrl(input.settings), {
      method: 'PUT',
      redirect: 'error',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(reminderPlan),
    });
    if (!reminderResponse.ok) {
      throw new Error(await responseError(reminderResponse, '云端拒绝保存手机提醒计划'));
    }
    this.setStatus({
      configured: true,
      enabled: true,
      serverUrl: input.settings.serverUrl,
      status: 'synced',
      lastSyncedAt: updatedAt,
      revision,
    });
  }

  private async requestProvision(serverUrl: string, setupToken: string): Promise<ProvisionResponse> {
    const response = await fetchWithTimeout(this.fetcher, `${serverUrl}/api/devices`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${setupToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ client: 'job-application-helper-desktop' }),
    });
    if (!response.ok) throw new Error(await responseError(response, '无法建立手机配对'));
    const raw = await readBoundedText(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('手机同步服务返回了无效数据');
    }
    if (!isProvisionResponse(parsed)) throw new Error('手机同步服务没有返回完整的配对凭据');
    return parsed;
  }

  private setStatus(state: DesktopMobileSyncState): void {
    this.status = state;
    this.listener?.(state);
  }
}

function snapshotInput(data: DesktopData, settings: StoredMobileSyncSettings): PendingSnapshot {
  return {
    records: structuredClone(data.records),
    careerFairs: structuredClone(data.careerFairs),
    settings: { ...settings },
  };
}

function encryptSnapshot(
  snapshot: ReturnType<typeof createMobileSnapshot>,
  deviceId: string,
  key: Buffer,
): EncryptedMobileSnapshot {
  const iv = randomBytes(12);
  const aad = Buffer.from(`job-application-helper-mobile:${deviceId}:${snapshot.revision}`, 'utf8');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(snapshot), 'utf8'),
    cipher.final(),
  ]);
  return {
    schemaVersion: 1,
    deviceId,
    revision: snapshot.revision,
    updatedAt: snapshot.generatedAt,
    algorithm: 'A256GCM',
    iv: iv.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

function createReminderPlan(
  records: DesktopData['records'],
  deviceId: string,
  key: Buffer,
  updatedAt: string,
): MobileReminderPlan {
  return {
    schemaVersion: 1,
    updatedAt,
    jobs: buildRecruitmentReminders(records).map(reminder => ({
      id: reminder.id,
      eventId: reminder.eventId,
      dueAt: reminder.dueAt,
      eventAt: reminder.eventAt,
      offsetMinutes: reminder.offsetMinutes,
      payload: encryptReminderPayload(
        boundedReminderMessage(recruitmentReminderMessage(reminder)),
        deviceId,
        reminder.id,
        key,
      ),
      notification: boundedReminderMessage(pushPlusReminderMessage(reminder)),
    })),
  };
}

function boundedReminderMessage(message: { title: string; body: string }): { title: string; body: string } {
  return { title: message.title.slice(0, 120), body: message.body.slice(0, 320) };
}

function encryptReminderPayload(
  message: { title: string; body: string },
  deviceId: string,
  reminderId: string,
  key: Buffer,
): EncryptedReminderPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`job-application-helper-reminder:${deviceId}:${reminderId}`, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(message), 'utf8'),
    cipher.final(),
  ]);
  return {
    algorithm: 'A256GCM',
    iv: iv.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

function normalizeServerUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请输入手机同步服务地址');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('手机同步服务地址格式无效');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('手机同步服务必须使用 HTTPS；本机测试可使用 localhost');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('手机同步服务地址不能包含账号、查询参数或片段');
  }
  return url.toString().replace(/\/$/, '');
}

function snapshotUrl(settings: StoredMobileSyncSettings): string {
  return `${settings.serverUrl}/api/snapshots/${encodeURIComponent(settings.deviceId)}`;
}

function reminderPlanUrl(settings: StoredMobileSyncSettings): string {
  return `${settings.serverUrl}/api/reminders/${encodeURIComponent(settings.deviceId)}`;
}

function isProvisionResponse(value: unknown): value is ProvisionResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Partial<ProvisionResponse>;
  return [input.deviceId, input.writeToken, input.readToken]
    .every(item => typeof item === 'string' && item.length >= 16);
}

async function fetchWithTimeout(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new Error('连接手机同步服务超时');
    throw new Error(`连接手机同步服务失败：${error instanceof Error ? error.message : '网络错误'}`);
  } finally {
    clearTimeout(timer);
  }
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const raw = await readBoundedText(response).catch(() => '');
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
  } catch {
    // Non-JSON error pages are intentionally not surfaced to avoid leaking server internals.
  }
  return `${fallback}（HTTP ${response.status}）`;
}

async function readBoundedText(response: Response): Promise<string> {
  const raw = await response.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('手机同步服务响应过大');
  return raw;
}

function disabledState(): DesktopMobileSyncState {
  return {
    configured: false,
    enabled: false,
    serverUrl: '',
    status: 'disabled',
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}
