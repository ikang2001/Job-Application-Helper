import { normalizeApplicationRecords } from '../../../src/shared/applicationRecords.ts';
import type { ApplicationRecord } from '../../../src/shared/types.ts';

export type DesktopSyncAction =
  | 'create-remote'
  | 'no-change'
  | 'upload-local'
  | 'download-remote'
  | 'conflict';

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortedValue(entry)]),
  );
}

export function stableStringifyRecords(records: readonly ApplicationRecord[]): string {
  const normalized = normalizeApplicationRecords(records)
    .sort((left, right) => left.id.localeCompare(right.id));
  return JSON.stringify(sortedValue(normalized));
}

export async function hashApplicationRecords(records: readonly ApplicationRecord[]): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringifyRecords(records));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function decideDesktopSyncAction(input: {
  baseHash?: string;
  localHash: string;
  remoteHash?: string;
  remoteExists: boolean;
  localCount: number;
  hasSourceBackup: boolean;
}): DesktopSyncAction {
  if (!input.remoteExists) {
    return !input.baseHash && input.hasSourceBackup ? 'create-remote' : 'conflict';
  }
  if (input.localHash === input.remoteHash) return 'no-change';
  if (!input.baseHash) return input.localCount === 0 ? 'download-remote' : 'conflict';
  if (input.remoteHash === input.baseHash) return 'upload-local';
  if (input.localHash === input.baseHash) return 'download-remote';
  return 'conflict';
}
