import {
  getRemoteDocument,
  normalizeWebDAVServerUrl,
  putRemoteApplicationRecordsCsv,
  putRemoteDocument,
  testConnection,
  validateWebDAVUrl,
  WebDAVError,
} from '../../../src/services/webdav.ts';
import { parseAndValidateBackup, serializeBackup } from '../../../src/shared/backup.ts';
import { normalizeApplicationRecords, serializeApplicationRecordsCsv } from '../../../src/shared/applicationRecords.ts';
import type { BackupDocument, WebDAVConfig } from '../../../src/shared/types.ts';
import { decideDesktopSyncAction, hashApplicationRecords } from '../domain/syncDecision.ts';
import type { DesktopWebDavInput } from '../shared/contracts.ts';
import type {
  DesktopData,
  SecretCodec,
  StoredWebDavSettings,
} from './desktopStore.ts';
import { DesktopStore } from './desktopStore.ts';

type SyncReason = 'manual' | 'auto';

export class DesktopSyncService {
  constructor(
    private readonly store: DesktopStore,
    private readonly secrets: SecretCodec,
  ) {}

  async saveSettings(input: DesktopWebDavInput): Promise<DesktopData> {
    const data = await this.store.read();
    const webdav = this.buildStoredSettings(input, data.webdav);
    const sync = webdav.enabled
      ? { ...data.sync, status: 'idle' as const, lastError: undefined }
      : { ...data.sync, status: 'disabled' as const, lastError: undefined };
    const next = { ...data, webdav, sync };
    await this.store.write(next);
    return next;
  }

  async test(input: DesktopWebDavInput): Promise<{ exists: boolean }> {
    const data = await this.store.read();
    const stored = this.buildStoredSettings(input, data.webdav);
    const result = await testConnection(this.toWebDavConfig(stored));
    return { exists: result.exists };
  }

  async perform(reason: SyncReason): Promise<DesktopData> {
    let data = await this.store.read();
    const webdav = data.webdav;
    if (!webdav || (!webdav.enabled && reason === 'auto')) {
      return this.saveSync(data, { ...data.sync, status: 'disabled', lastError: undefined });
    }
    data = await this.saveSync(data, { ...data.sync, status: 'syncing', lastError: undefined });
    try {
      return await this.synchronize(data, this.toWebDavConfig(webdav));
    } catch (error) {
      return this.saveSyncError(data, error);
    }
  }

  async resolveConflict(choice: 'local' | 'remote'): Promise<DesktopData> {
    let data = await this.store.read();
    const webdav = data.webdav;
    if (!webdav) throw new Error('请先配置 WebDAV');
    data = await this.saveSync(data, { ...data.sync, status: 'syncing', lastError: undefined });
    try {
      return choice === 'local'
        ? await this.forceUpload(data, this.toWebDavConfig(webdav))
        : await this.forceDownload(data, this.toWebDavConfig(webdav));
    } catch (error) {
      return this.saveSyncError(data, error);
    }
  }

  private async synchronize(data: DesktopData, config: WebDAVConfig): Promise<DesktopData> {
    const remote = await getRemoteDocument(config);
    const remoteDocument = remote.exists ? this.parseRemote(remote.json) : undefined;
    const remoteRecords = normalizeApplicationRecords(remoteDocument?.data.applicationRecords ?? []);
    const [localHash, remoteHash] = await Promise.all([
      hashApplicationRecords(data.records),
      remote.exists ? hashApplicationRecords(remoteRecords) : Promise.resolve(undefined),
    ]);
    const action = decideDesktopSyncAction({
      baseHash: data.sync.baseRecordsHash,
      localHash,
      remoteHash,
      remoteExists: remote.exists,
      localCount: data.records.length,
      hasSourceBackup: Boolean(data.sourceBackup),
    });
    if (action === 'create-remote' && data.sourceBackup) {
      return this.upload(data, data.sourceBackup, config, { type: 'create' });
    }
    if (action === 'upload-local' && remoteDocument) {
      return this.upload(data, remoteDocument, config, this.updateCondition(remote.etag));
    }
    if (action === 'download-remote' && remoteDocument && remoteHash) {
      return this.acceptRemote(data, remoteDocument, remoteRecords, remoteHash, remote.etag);
    }
    if (action === 'no-change' && remoteDocument && remoteHash) {
      await putRemoteApplicationRecordsCsv(config, serializeApplicationRecordsCsv(data.records));
      return this.acceptRemote(data, remoteDocument, data.records, remoteHash, remote.etag);
    }
    if (!remote.exists) {
      throw new Error('远端没有完整备份；请先让浏览器扩展同步一次，或导入扩展导出的完整 JSON');
    }
    return this.saveConflict(data, remoteRecords.length, remoteDocument?.exportedAt, remote.etag);
  }

  private async upload(
    data: DesktopData,
    source: BackupDocument,
    config: WebDAVConfig,
    condition: { type: 'create' } | { type: 'update'; etag: string },
  ): Promise<DesktopData> {
    const document = this.withApplicationRecords(source, data.records);
    const result = await putRemoteDocument(config, serializeBackup(document), condition);
    await putRemoteApplicationRecordsCsv(config, serializeApplicationRecordsCsv(data.records));
    const etag = result.etag ?? (await getRemoteDocument(config)).etag;
    if (!etag) throw new WebDAVError('MISSING_ETAG', '远端未提供 ETag，无法继续安全同步');
    const baseRecordsHash = await hashApplicationRecords(data.records);
    return this.complete({ ...data, sourceBackup: document }, baseRecordsHash, etag);
  }

  private async forceUpload(data: DesktopData, config: WebDAVConfig): Promise<DesktopData> {
    const remote = await getRemoteDocument(config);
    const remoteDocument = remote.exists ? this.parseRemote(remote.json) : undefined;
    const source = remoteDocument ?? data.sourceBackup;
    if (!source) throw new Error('远端没有完整备份；请先从扩展导入完整 JSON 备份');
    return this.upload(
      data,
      source,
      config,
      remote.exists ? this.updateCondition(remote.etag) : { type: 'create' },
    );
  }

  private async forceDownload(data: DesktopData, config: WebDAVConfig): Promise<DesktopData> {
    const remote = await getRemoteDocument(config);
    if (!remote.exists) throw new Error('远端备份不存在，无法下载');
    const document = this.parseRemote(remote.json);
    const records = normalizeApplicationRecords(document.data.applicationRecords ?? []);
    const hash = await hashApplicationRecords(records);
    return this.acceptRemote(data, document, records, hash, remote.etag);
  }

  private async acceptRemote(
    data: DesktopData,
    document: BackupDocument,
    records: DesktopData['records'],
    baseRecordsHash: string,
    etag?: string,
  ): Promise<DesktopData> {
    if (!etag) throw new WebDAVError('MISSING_ETAG', '远端未提供 ETag，无法继续安全同步');
    return this.complete({ ...data, records, sourceBackup: document }, baseRecordsHash, etag);
  }

  private async complete(data: DesktopData, baseRecordsHash: string, etag: string): Promise<DesktopData> {
    const next: DesktopData = {
      ...data,
      sync: {
        status: 'synced',
        lastSyncedAt: new Date().toISOString(),
        baseRecordsHash,
        etag,
      },
    };
    await this.store.write(next);
    return next;
  }

  private async saveConflict(
    data: DesktopData,
    remoteCount: number,
    remoteExportedAt?: string,
    etag?: string,
  ): Promise<DesktopData> {
    return this.saveSync(data, {
      ...data.sync,
      status: 'conflict',
      etag,
      lastError: '桌面端和远端投递记录都有变化，请选择保留版本',
      conflict: { localCount: data.records.length, remoteCount, remoteExportedAt },
    });
  }

  private async saveSyncError(data: DesktopData, error: unknown): Promise<DesktopData> {
    const conflict = error instanceof WebDAVError && error.code === 'PRECONDITION_FAILED';
    return this.saveSync(data, {
      ...data.sync,
      status: conflict ? 'conflict' : 'error',
      lastError: error instanceof Error ? error.message : 'WebDAV 同步失败',
    });
  }

  private async saveSync(data: DesktopData, sync: DesktopData['sync']): Promise<DesktopData> {
    const next = { ...data, sync };
    await this.store.write(next);
    return next;
  }

  private buildStoredSettings(
    input: DesktopWebDavInput,
    current?: StoredWebDavSettings,
  ): StoredWebDavSettings {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('WebDAV 设置格式无效');
    }
    if (
      typeof input.enabled !== 'boolean'
      || typeof input.serverUrl !== 'string'
      || typeof input.username !== 'string'
      || (input.password !== undefined && typeof input.password !== 'string')
    ) {
      throw new Error('WebDAV 设置字段格式无效');
    }
    const serverUrl = input.serverUrl.trim()
      ? normalizeWebDAVServerUrl(input.serverUrl)
      : '';
    if (serverUrl) {
      const error = validateWebDAVUrl(serverUrl);
      if (error) throw new Error(error);
    }
    const encryptedPassword = input.password?.trim()
      ? this.secrets.encrypt(input.password)
      : current?.encryptedPassword ?? '';
    if ((input.enabled || serverUrl) && (!serverUrl || !input.username.trim() || !encryptedPassword)) {
      throw new Error('请完整填写 WebDAV 地址、用户名和密码');
    }
    return {
      enabled: input.enabled,
      serverUrl,
      username: input.username.trim(),
      encryptedPassword,
    };
  }

  private toWebDavConfig(settings: StoredWebDavSettings): WebDAVConfig {
    if (!settings.serverUrl || !settings.username || !settings.encryptedPassword) {
      throw new Error('请先完整配置 WebDAV');
    }
    return {
      enabled: settings.enabled,
      serverUrl: settings.serverUrl,
      username: settings.username,
      password: this.secrets.decrypt(settings.encryptedPassword),
    };
  }

  private parseRemote(raw: string | undefined): BackupDocument {
    if (!raw) throw new Error('远端备份内容为空');
    const parsed = parseAndValidateBackup(raw);
    if (!parsed.success) throw new Error(`远端备份无效：${parsed.error.message}`);
    return parsed.document;
  }

  private withApplicationRecords(source: BackupDocument, records: DesktopData['records']): BackupDocument {
    return {
      ...structuredClone(source),
      exportedAt: new Date().toISOString(),
      data: {
        ...structuredClone(source.data),
        applicationRecords: normalizeApplicationRecords(records),
      },
    };
  }

  private updateCondition(etag?: string): { type: 'update'; etag: string } {
    if (!etag) throw new WebDAVError('MISSING_ETAG', '远端未提供 ETag，已停止覆盖');
    return { type: 'update', etag };
  }
}
