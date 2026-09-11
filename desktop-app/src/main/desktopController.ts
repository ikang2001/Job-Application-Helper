import { serializeApplicationRecordsCsv } from '../../../src/shared/applicationRecords.ts';
import type {
  DesktopCareerFairInput,
  DesktopCareerFairSaveResult,
  DesktopMailReviewDecisionInput,
  DesktopRecordInput,
  DesktopRecordSaveResult,
  DesktopMobilePairingInfo,
  DesktopMobileSyncSetupInput,
  DesktopRecordFavoriteInput,
  DesktopState,
  DesktopWebDavInput,
} from '../shared/contracts.ts';
import { deleteCareerFair, saveCareerFair } from '../domain/careerFairs.ts';
import {
  confirmDesktopMailReview,
  ignoreDesktopMailReview,
  ignoreDesktopMailReviews,
} from '../domain/desktopMail.ts';
import {
  deleteDesktopRecord,
  mergeDesktopCsv,
  parseDesktopRecordsJson,
  saveDesktopRecord,
  serializeDesktopData,
} from '../domain/records.ts';
import { DesktopStore, type DesktopData } from './desktopStore.ts';
import { DesktopLocalSyncService } from './desktopLocalSyncService.ts';
import { DesktopSyncService } from './desktopSyncService.ts';
import { MobileSnapshotSyncService } from './mobileSnapshotSyncService.ts';
import { DesktopMailInboxService } from './desktopMailInboxService.ts';

export class DesktopController {
  private queue: Promise<unknown> = Promise.resolve();
  private stateListener?: (state: DesktopState) => void;
  private lastNotifiedData?: DesktopData;
  private mailScan?: Promise<DesktopState>;

  constructor(
    private readonly store: DesktopStore,
    private readonly syncService: DesktopSyncService,
    private readonly localSyncService: DesktopLocalSyncService,
    private readonly mobileSnapshotSyncService: MobileSnapshotSyncService,
    private readonly mailInboxService: DesktopMailInboxService,
    private readonly desktopReminderSupported = true,
  ) {}

  getState(): Promise<DesktopState> {
    return this.enqueue(async () => this.toState(await this.syncLocal(await this.store.read())));
  }

  start(listener: (state: DesktopState) => void): Promise<void> {
    this.stateListener = listener;
    this.mobileSnapshotSyncService.setStateListener(() => {
      if (this.lastNotifiedData) this.stateListener?.(this.toState(this.lastNotifiedData));
    });
    return this.enqueue(async () => {
      const data = await this.syncLocal(await this.store.read());
      this.localSyncService.watch(() => { void this.refreshFromShared(); });
      this.mailInboxService.start(() => {
        void this.scanMail().catch(error => console.error('桌面招聘邮箱自动扫描失败', error));
      });
      this.notify(data);
    });
  }

  stop(): void {
    this.localSyncService.stop();
    this.mailInboxService.stop();
  }

  async flushMobileSnapshot(): Promise<void> {
    const data = this.lastNotifiedData ?? await this.store.read();
    await this.mobileSnapshotSyncService.flush(data);
  }

  saveRecord(input: DesktopRecordInput): Promise<DesktopRecordSaveResult> {
    return this.enqueue(async () => {
      const data = await this.store.read();
      const saved = saveDesktopRecord(data.records, input);
      let next = { ...data, records: saved.records, sync: this.markLocalChange(data) };
      await this.store.write(next);
      next = await this.syncLocal(next);
      next = await this.autoSync(next);
      this.notify(next);
      return {
        state: this.toState(next),
        recordId: saved.record.id,
        duplicate: saved.duplicate
          ? {
              id: saved.duplicate.id,
              companyName: saved.duplicate.companyName,
              jobTitle: saved.duplicate.jobTitle,
            }
          : undefined,
      };
    });
  }

  deleteRecord(id: string): Promise<DesktopState> {
    return this.enqueue(async () => {
      const data = await this.store.read();
      let next = {
        ...data,
        records: deleteDesktopRecord(data.records, id),
        favoriteRecordIds: data.favoriteRecordIds.filter(recordId => recordId !== id),
        sync: this.markLocalChange(data),
      };
      await this.store.write(next);
      next = await this.syncLocal(next, data.records.some(record => record.id === id) ? [id] : []);
      next = await this.autoSync(next);
      this.notify(next);
      return this.toState(next);
    });
  }

  setRecordFavorite(input: DesktopRecordFavoriteInput): Promise<DesktopState> {
    return this.enqueue(async () => {
      if (!input || typeof input.recordId !== 'string' || typeof input.favorite !== 'boolean') {
        throw new Error('收藏参数无效');
      }
      const recordId = input.recordId.trim();
      const data = await this.store.read();
      if (!recordId || !data.records.some(record => record.id === recordId)) {
        throw new Error('要收藏的投递记录不存在');
      }
      const favorites = new Set(data.favoriteRecordIds);
      if (input.favorite) favorites.add(recordId);
      else favorites.delete(recordId);
      const next = { ...data, favoriteRecordIds: [...favorites] };
      await this.store.write(next);
      this.notify(next, false);
      return this.toState(next);
    });
  }

  saveCareerFair(input: DesktopCareerFairInput): Promise<DesktopCareerFairSaveResult> {
    return this.enqueue(async () => {
      const data = await this.store.read();
      const saved = saveCareerFair(data.careerFairs, input);
      const next = { ...data, careerFairs: saved.careerFairs };
      await this.store.write(next);
      this.notify(next);
      return { state: this.toState(next), careerFairId: saved.careerFair.id };
    });
  }

  deleteCareerFair(id: string): Promise<DesktopState> {
    return this.enqueue(async () => {
      const data = await this.store.read();
      const next = { ...data, careerFairs: deleteCareerFair(data.careerFairs, id) };
      await this.store.write(next);
      this.notify(next);
      return this.toState(next);
    });
  }

  importJson(raw: string): Promise<{ state: DesktopState; imported: number; warnings: string[] }> {
    return this.enqueue(async () => {
      const parsed = parseDesktopRecordsJson(raw);
      const data = await this.store.read();
      let next: DesktopData = {
        ...data,
        records: parsed.records,
        careerFairs: parsed.careerFairs ?? data.careerFairs,
        sourceBackup: parsed.sourceBackup ?? data.sourceBackup,
        sync: { status: 'idle' },
      };
      await this.store.write(next);
      next = await this.syncLocal(next, removedRecordIds(data.records, next.records));
      this.notify(next);
      return { state: this.toState(next), imported: parsed.records.length, warnings: parsed.warnings };
    });
  }

  importCsv(csv: string): Promise<{ state: DesktopState; imported: number; warnings: string[] }> {
    return this.enqueue(async () => {
      const data = await this.store.read();
      const merged = mergeDesktopCsv(data.records, csv);
      let next = { ...data, records: merged.records, sync: this.markLocalChange(data) };
      await this.store.write(next);
      next = await this.syncLocal(next);
      next = await this.autoSync(next);
      this.notify(next);
      return { state: this.toState(next), imported: merged.imported, warnings: merged.warnings };
    });
  }

  exportJson(): Promise<string> {
    return this.enqueue(async () => {
      const data = await this.store.read();
      return serializeDesktopData(data.records, data.careerFairs);
    });
  }

  exportCsv(): Promise<string> {
    return this.enqueue(async () => serializeApplicationRecordsCsv((await this.store.read()).records));
  }

  saveWebDav(input: DesktopWebDavInput): Promise<DesktopState> {
    return this.enqueue(async () => {
      const data = await this.syncService.saveSettings(input);
      this.notify(data);
      return this.toState(data);
    });
  }

  testWebDav(input: DesktopWebDavInput): Promise<{ exists: boolean }> {
    return this.enqueue(() => this.syncService.test(input));
  }

  syncNow(): Promise<DesktopState> {
    return this.enqueue(async () => {
      let data = await this.syncLocal(await this.store.read());
      if (data.webdav?.enabled) data = await this.syncService.perform('manual');
      this.notify(data);
      return this.toState(data);
    });
  }

  resolveConflict(choice: 'local' | 'remote'): Promise<DesktopState> {
    if (choice !== 'local' && choice !== 'remote') return Promise.reject(new Error('同步冲突选择无效'));
    return this.enqueue(async () => {
      const current = await this.store.read();
      let data = await this.syncService.resolveConflict(choice);
      data = await this.syncLocal(data, removedRecordIds(current.records, data.records));
      this.notify(data);
      return this.toState(data);
    });
  }

  setupMobileSync(input: DesktopMobileSyncSetupInput): Promise<DesktopState> {
    return this.enqueue(async () => {
      const next = await this.mobileSnapshotSyncService.provision(await this.store.read(), input);
      this.notify(next);
      return this.toState(next);
    });
  }

  setMobileSyncEnabled(enabled: boolean): Promise<DesktopState> {
    return this.enqueue(async () => {
      const next = await this.mobileSnapshotSyncService.setEnabled(await this.store.read(), enabled);
      this.notify(next);
      return this.toState(next);
    });
  }

  setDesktopReminderEnabled(enabled: boolean): Promise<DesktopState> {
    return this.enqueue(async () => {
      if (typeof enabled !== 'boolean') throw new Error('桌面提醒设置无效');
      if (enabled && !this.desktopReminderSupported) throw new Error('当前系统不支持桌面通知');
      const data = await this.store.read();
      const next: DesktopData = { ...data, desktopReminder: { enabled } };
      await this.store.write(next);
      this.notify(next, false);
      return this.toState(next);
    });
  }

  syncMobileNow(): Promise<DesktopState> {
    return this.enqueue(async () => {
      const data = await this.store.read();
      await this.mobileSnapshotSyncService.syncNow(data);
      this.notify(data, false);
      return this.toState(data);
    });
  }

  getMobilePairing(): Promise<DesktopMobilePairingInfo> {
    return this.enqueue(async () => (
      this.mobileSnapshotSyncService.getPairingInfo((await this.store.read()).mobileSync)
    ));
  }

  scanMail(): Promise<DesktopState> {
    if (this.mailScan) return this.mailScan;
    this.mailScan = this.performMailScan().finally(() => {
      this.mailScan = undefined;
    });
    return this.mailScan;
  }

  confirmMailReview(input: DesktopMailReviewDecisionInput): Promise<DesktopState> {
    return this.enqueue(async () => {
      const data = await this.store.read();
      const inbox = data.mailInbox ?? emptyMailInbox();
      const decision = confirmDesktopMailReview(data.records, inbox.reviews, input);
      let next: DesktopData = {
        ...data,
        records: decision.records,
        mailInbox: { ...inbox, reviews: decision.reviews },
        sync: this.markLocalChange(data),
      };
      await this.store.write(next);
      next = await this.syncLocal(next);
      next = await this.autoSync(next);
      this.notify(next);
      return this.toState(next);
    });
  }

  ignoreMailReview(reviewId: string): Promise<DesktopState> {
    return this.enqueue(async () => {
      const data = await this.store.read();
      const inbox = data.mailInbox ?? emptyMailInbox();
      const next: DesktopData = {
        ...data,
        mailInbox: { ...inbox, reviews: ignoreDesktopMailReview(inbox.reviews, reviewId) },
      };
      await this.store.write(next);
      this.notify(next, false);
      return this.toState(next);
    });
  }

  ignoreMailReviews(reviewIds: string[]): Promise<DesktopState> {
    return this.enqueue(async () => {
      if (!Array.isArray(reviewIds) || reviewIds.length > 500) throw new Error('批量忽略参数无效');
      const data = await this.store.read();
      const inbox = data.mailInbox ?? emptyMailInbox();
      const next: DesktopData = {
        ...data,
        mailInbox: { ...inbox, reviews: ignoreDesktopMailReviews(inbox.reviews, reviewIds) },
      };
      await this.store.write(next);
      this.notify(next, false);
      return this.toState(next);
    });
  }

  private markLocalChange(data: DesktopData): DesktopData['sync'] {
    return {
      ...data.sync,
      status: data.webdav?.enabled ? 'idle' : 'disabled',
      lastError: undefined,
      conflict: undefined,
    };
  }

  private async autoSync(data: DesktopData): Promise<DesktopData> {
    return data.webdav?.enabled ? this.syncService.perform('auto') : data;
  }

  private async syncLocal(data: DesktopData, deletedIds: readonly string[] = []): Promise<DesktopData> {
    try {
      const records = await this.localSyncService.synchronize(data.records, deletedIds);
      const next = { ...data, records };
      await this.store.write(next);
      return next;
    } catch (error) {
      console.error('本机投递记录同步失败，本地保存已保留', error);
      return data;
    }
  }

  private async performMailScan(): Promise<DesktopState> {
    const basis = await this.enqueue(() => this.store.read());
    const scanning: DesktopData = {
      ...basis,
      mailInbox: { ...(basis.mailInbox ?? emptyMailInbox()), status: 'scanning', lastError: undefined },
    };
    this.stateListener?.(this.toState(scanning));
    try {
      const scanned = await this.mailInboxService.scan(basis);
      return this.enqueue(async () => {
        const latest = await this.store.read();
        const next = { ...latest, mailInbox: scanned.mailInbox };
        await this.store.write(next);
        this.notify(next, false);
        return this.toState(next);
      });
    } catch (error) {
      return this.enqueue(async () => {
        const latest = await this.store.read();
        const inbox = latest.mailInbox ?? emptyMailInbox();
        const next: DesktopData = {
          ...latest,
          mailInbox: {
            ...inbox,
            status: 'error',
            lastScannedAt: new Date().toISOString(),
            lastError: error instanceof Error ? error.message : '招聘邮箱扫描失败',
          },
        };
        await this.store.write(next);
        this.notify(next, false);
        return this.toState(next);
      });
    }
  }

  private refreshFromShared(): Promise<void> {
    return this.enqueue(async () => {
      const data = await this.syncLocal(await this.store.read());
      this.notify(data);
    });
  }

  private notify(data: DesktopData, scheduleMobile = true): void {
    this.lastNotifiedData = data;
    this.stateListener?.(this.toState(data));
    if (scheduleMobile) this.mobileSnapshotSyncService.schedule(data);
  }

  private toState(data: DesktopData): DesktopState {
    return {
      records: data.records,
      favoriteRecordIds: retainedFavoriteRecordIds(data.favoriteRecordIds, data.records),
      careerFairs: data.careerFairs,
      desktopReminder: {
        enabled: data.desktopReminder?.enabled ?? true,
        supported: this.desktopReminderSupported,
      },
      localSync: this.localSyncService.getState(),
      mobileSync: this.mobileSnapshotSyncService.getState(data.mobileSync),
      mailInbox: {
        status: data.mailInbox?.status ?? 'idle',
        accounts: data.mailInbox?.accounts ?? [],
        reviews: data.mailInbox?.reviews ?? [],
        pendingCount: data.mailInbox?.reviews.filter(review => review.state === 'pending').length ?? 0,
        lastScannedAt: data.mailInbox?.lastScannedAt,
        lastError: data.mailInbox?.lastError,
      },
      sync: {
        status: data.sync.status,
        lastSyncedAt: data.sync.lastSyncedAt,
        lastError: data.sync.lastError,
        conflict: data.sync.conflict,
      },
      webdav: {
        enabled: data.webdav?.enabled ?? false,
        serverUrl: data.webdav?.serverUrl ?? '',
        username: data.webdav?.username ?? '',
        passwordConfigured: Boolean(data.webdav?.encryptedPassword),
      },
    };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function emptyMailInbox(): NonNullable<DesktopData['mailInbox']> {
  return { status: 'idle', accounts: [], reviews: [], cursors: {} };
}

function removedRecordIds(
  previous: readonly { id: string }[],
  next: readonly { id: string }[],
): string[] {
  const nextIds = new Set(next.map(record => record.id));
  return previous.filter(record => !nextIds.has(record.id)).map(record => record.id);
}

function retainedFavoriteRecordIds(
  favoriteRecordIds: readonly string[],
  records: readonly { id: string }[],
): string[] {
  const recordIds = new Set(records.map(record => record.id));
  return favoriteRecordIds.filter(id => recordIds.has(id));
}
