import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const LOCAL_APPLICATION_RECORDS_SCHEMA_VERSION = 1 as const;
export const LOCAL_APPLICATION_RECORDS_CHUNK_BYTES = 384 * 1024;

export type LocalRecordsWriter = 'edge' | 'desktop';

export type LocalApplicationRecord = object & {
  id: string;
  updatedAt: string;
};

export interface LocalApplicationRecordTombstone {
  id: string;
  deletedAt: string;
}

export interface LocalApplicationRecordsDocument {
  schemaVersion: 1;
  revision: number;
  updatedAt: string;
  writer: LocalRecordsWriter;
  records: LocalApplicationRecord[];
  tombstones: LocalApplicationRecordTombstone[];
}

export interface LocalApplicationRecordsMerge {
  writer: LocalRecordsWriter;
  records: LocalApplicationRecord[];
  tombstones?: LocalApplicationRecordTombstone[];
}

export interface LocalApplicationRecordsMeta {
  revision: number;
  updatedAt: string;
  writer: LocalRecordsWriter;
  recordCount: number;
  sizeBytes: number;
  chunkBytes: number;
  chunkCount: number;
  sha256: string;
  filePath: string;
}

export interface LocalApplicationRecordsChunk {
  revision: number;
  index: number;
  chunkCount: number;
  base64: string;
}

export class LocalRecordsStoreError extends Error {
  constructor(
    readonly code: 'INVALID_REQUEST' | 'STALE_REVISION',
    message: string,
  ) {
    super(message);
    this.name = 'LocalRecordsStoreError';
  }
}

export function defaultLocalRecordsStorePath(): string {
  const base = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || process.env.APPDATA || homedir()
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'JobApplicationHelper', 'application-records-sync.json');
}

export class LocalApplicationRecordsStore {
  readonly filePath: string;
  private readonly backupPath: string;
  private readonly lockPath: string;

  constructor(filePath = defaultLocalRecordsStorePath()) {
    this.filePath = filePath;
    this.backupPath = `${filePath}.bak`;
    this.lockPath = `${filePath}.lock`;
  }

  async read(): Promise<LocalApplicationRecordsDocument> {
    try {
      return parseDocument(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      if (isMissing(error)) return this.readBackupOrEmpty();
      return this.readBackupOrThrow(error);
    }
  }

  async merge(input: LocalApplicationRecordsMerge): Promise<LocalApplicationRecordsDocument> {
    const normalizedInput = normalizeMerge(input);
    return this.withLock(async () => {
      const current = await this.read();
      const merged = mergeDocuments(current, normalizedInput);
      if (samePayload(current, merged)) return current;
      await this.write(merged);
      return merged;
    });
  }

  async getMeta(): Promise<LocalApplicationRecordsMeta> {
    const { document, bytes } = await this.snapshot();
    return buildMeta(document, bytes, this.filePath);
  }

  async readChunk(
    revision: number,
    index: number,
    chunkBytes = LOCAL_APPLICATION_RECORDS_CHUNK_BYTES,
  ): Promise<LocalApplicationRecordsChunk> {
    const { document, bytes } = await this.snapshot();
    if (document.revision !== revision) {
      throw new LocalRecordsStoreError('STALE_REVISION', '投递记录已更新，请重新读取元数据');
    }
    const boundedChunkBytes = Math.max(64 * 1024, Math.min(LOCAL_APPLICATION_RECORDS_CHUNK_BYTES, chunkBytes));
    const chunkCount = Math.max(1, Math.ceil(bytes.length / boundedChunkBytes));
    if (!Number.isInteger(index) || index < 0 || index >= chunkCount) {
      throw new LocalRecordsStoreError('INVALID_REQUEST', '投递记录分块序号无效');
    }
    const start = index * boundedChunkBytes;
    return {
      revision,
      index,
      chunkCount,
      base64: bytes.subarray(start, start + boundedChunkBytes).toString('base64'),
    };
  }

  private async snapshot(): Promise<{ document: LocalApplicationRecordsDocument; bytes: Buffer }> {
    const document = await this.read();
    return { document, bytes: Buffer.from(JSON.stringify(document), 'utf8') };
  }

  private async readBackupOrEmpty(): Promise<LocalApplicationRecordsDocument> {
    try {
      return parseDocument(JSON.parse(await readFile(this.backupPath, 'utf8')));
    } catch (error) {
      if (isMissing(error)) return emptyDocument();
      throw new Error('本机投递记录同步文件损坏，且备份文件无法恢复');
    }
  }

  private async readBackupOrThrow(primaryError: unknown): Promise<LocalApplicationRecordsDocument> {
    try {
      const recovered = parseDocument(JSON.parse(await readFile(this.backupPath, 'utf8')));
      console.error('[LocalRecords] 主同步文件读取失败，已使用备份', primaryError);
      return recovered;
    } catch {
      throw new Error('本机投递记录同步文件损坏，且备份文件无法恢复');
    }
  }

  private async write(document: LocalApplicationRecordsDocument): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await copyFile(this.filePath, this.backupPath).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
      await writeFile(temporaryPath, JSON.stringify(document, null, 2), { encoding: 'utf8', mode: 0o600 });
      if (process.platform !== 'win32') await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.filePath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const release = await acquireFileLock(this.lockPath);
    try {
      return await operation();
    } finally {
      await release();
    }
  }
}

function emptyDocument(): LocalApplicationRecordsDocument {
  return {
    schemaVersion: LOCAL_APPLICATION_RECORDS_SCHEMA_VERSION,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    writer: 'desktop',
    records: [],
    tombstones: [],
  };
}

function normalizeMerge(input: LocalApplicationRecordsMerge): LocalApplicationRecordsMerge {
  if (!input || (input.writer !== 'edge' && input.writer !== 'desktop') || !Array.isArray(input.records)) {
    throw new LocalRecordsStoreError('INVALID_REQUEST', '投递记录合并请求格式无效');
  }
  return {
    writer: input.writer,
    records: input.records.map(normalizeRecord),
    tombstones: (input.tombstones ?? []).map(normalizeTombstone),
  };
}

function parseDocument(value: unknown): LocalApplicationRecordsDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('本机投递记录同步文件不是对象');
  }
  const input = value as Partial<LocalApplicationRecordsDocument>;
  if (
    input.schemaVersion !== LOCAL_APPLICATION_RECORDS_SCHEMA_VERSION
    || !Number.isInteger(input.revision)
    || Number(input.revision) < 0
    || (input.writer !== 'edge' && input.writer !== 'desktop')
    || !Array.isArray(input.records)
    || !Array.isArray(input.tombstones)
    || !isIsoDate(input.updatedAt)
  ) {
    throw new Error('本机投递记录同步文件格式无效');
  }
  return {
    schemaVersion: LOCAL_APPLICATION_RECORDS_SCHEMA_VERSION,
    revision: Number(input.revision),
    updatedAt: input.updatedAt,
    writer: input.writer,
    records: input.records.map(normalizeRecord).sort(byId),
    tombstones: input.tombstones.map(normalizeTombstone).sort(byId),
  };
}

function normalizeRecord(value: unknown): LocalApplicationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalRecordsStoreError('INVALID_REQUEST', '投递记录必须是对象');
  }
  const input = value as Record<string, unknown>;
  const id = requireIdentifier(input.id, '投递记录 ID');
  const updatedAt = recordUpdatedAt(input);
  return { ...input, id, updatedAt };
}

function normalizeTombstone(value: unknown): LocalApplicationRecordTombstone {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalRecordsStoreError('INVALID_REQUEST', '删除标记必须是对象');
  }
  const input = value as Record<string, unknown>;
  return {
    id: requireIdentifier(input.id, '删除标记 ID'),
    deletedAt: requireIsoDate(input.deletedAt, '删除时间'),
  };
}

function mergeDocuments(
  current: LocalApplicationRecordsDocument,
  input: LocalApplicationRecordsMerge,
): LocalApplicationRecordsDocument {
  const records = new Map(current.records.map(record => [record.id, record]));
  const tombstones = new Map(current.tombstones.map(tombstone => [tombstone.id, tombstone]));

  for (const tombstone of input.tombstones ?? []) {
    const existing = tombstones.get(tombstone.id);
    if (!existing || compareTimestamp(tombstone.deletedAt, existing.deletedAt) > 0) {
      tombstones.set(tombstone.id, tombstone);
    }
  }
  for (const record of input.records) {
    const existing = records.get(record.id);
    if (!existing || preferIncomingRecord(existing, record)) records.set(record.id, record);
  }
  for (const [id, tombstone] of tombstones) {
    const record = records.get(id);
    if (!record || compareTimestamp(tombstone.deletedAt, record.updatedAt) >= 0) {
      records.delete(id);
    } else {
      tombstones.delete(id);
    }
  }

  return {
    schemaVersion: LOCAL_APPLICATION_RECORDS_SCHEMA_VERSION,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
    writer: input.writer,
    records: [...records.values()].sort(byId),
    tombstones: [...tombstones.values()].sort(byId),
  };
}

function samePayload(
  left: LocalApplicationRecordsDocument,
  right: LocalApplicationRecordsDocument,
): boolean {
  return JSON.stringify(left.records) === JSON.stringify(right.records)
    && JSON.stringify(left.tombstones) === JSON.stringify(right.tombstones);
}

function preferIncomingRecord(current: LocalApplicationRecord, incoming: LocalApplicationRecord): boolean {
  const timestampOrder = compareTimestamp(incoming.updatedAt, current.updatedAt);
  if (timestampOrder !== 0) return timestampOrder > 0;
  return JSON.stringify(incoming).localeCompare(JSON.stringify(current)) > 0;
}

function compareTimestamp(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

function byId<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new LocalRecordsStoreError('INVALID_REQUEST', `${label} 无效`);
  }
  return value.trim();
}

function requireIsoDate(value: unknown, label: string): string {
  if (!isIsoDate(value)) throw new LocalRecordsStoreError('INVALID_REQUEST', `${label}无效`);
  return value;
}

function recordUpdatedAt(record: Record<string, unknown>): string {
  for (const value of [record.updatedAt, record.createdAt, record.appliedAt]) {
    if (isIsoDate(value)) return new Date(value).toISOString();
  }
  return new Date(0).toISOString();
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function buildMeta(
  document: LocalApplicationRecordsDocument,
  bytes: Buffer,
  filePath: string,
): LocalApplicationRecordsMeta {
  return {
    revision: document.revision,
    updatedAt: document.updatedAt,
    writer: document.writer,
    recordCount: document.records.length,
    sizeBytes: bytes.length,
    chunkBytes: LOCAL_APPLICATION_RECORDS_CHUNK_BYTES,
    chunkCount: Math.max(1, Math.ceil(bytes.length / LOCAL_APPLICATION_RECORDS_CHUNK_BYTES)),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    filePath,
  };
}

async function acquireFileLock(lockPath: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
      return async () => {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await removeStaleLock(lockPath);
      await delay(25);
    }
  }
  throw new Error('本机投递记录正被另一个进程占用，请稍后重试');
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs > 15_000) await rm(lockPath, { force: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
