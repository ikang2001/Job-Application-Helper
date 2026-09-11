import { watchFile, unwatchFile } from 'node:fs';
import { normalizeApplicationRecords } from '../../../src/shared/applicationRecords.ts';
import type { ApplicationRecord } from '../../../src/shared/types.ts';
import {
  LocalApplicationRecordsStore,
  type LocalApplicationRecord,
} from '../../../native-mail-companion/src/localRecordsStore.ts';
import type { DesktopLocalSyncState } from '../shared/contracts.ts';

export class DesktopLocalSyncService {
  private state: DesktopLocalSyncState = { status: 'checking' };
  private watching = false;

  constructor(
    private readonly sharedStore = new LocalApplicationRecordsStore(),
  ) {}

  getState(): DesktopLocalSyncState {
    return { ...this.state };
  }

  async synchronize(
    records: readonly ApplicationRecord[],
    deletedIds: readonly string[] = [],
  ): Promise<ApplicationRecord[]> {
    this.state = { ...this.state, status: 'syncing', lastError: undefined };
    try {
      const deletedAt = new Date().toISOString();
      const document = await this.sharedStore.merge({
        writer: 'desktop',
        records: normalizeApplicationRecords(records) as LocalApplicationRecord[],
        tombstones: [...new Set(deletedIds.filter(Boolean))].map(id => ({ id, deletedAt })),
      });
      const merged = normalizeApplicationRecords(document.records);
      this.state = {
        status: 'synced',
        lastSyncedAt: new Date().toISOString(),
        revision: document.revision,
        recordCount: merged.length,
        filePath: this.sharedStore.filePath,
      };
      return merged;
    } catch (error) {
      this.state = {
        status: 'error',
        lastError: error instanceof Error ? error.message : '本机投递记录同步失败',
        filePath: this.sharedStore.filePath,
      };
      throw error;
    }
  }

  watch(onChanged: () => void): void {
    if (this.watching) return;
    this.watching = true;
    watchFile(this.sharedStore.filePath, { interval: 1_000, persistent: false }, (current, previous) => {
      if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
      onChanged();
    });
  }

  stop(): void {
    if (!this.watching) return;
    unwatchFile(this.sharedStore.filePath);
    this.watching = false;
  }
}
