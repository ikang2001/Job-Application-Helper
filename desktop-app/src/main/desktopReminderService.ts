import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ApplicationRecord } from '../../../src/shared/types.ts';
import {
  buildRecruitmentReminders,
  selectDueReminderGroups,
  type RecruitmentReminder,
} from '../domain/reminders.ts';

const CHECK_INTERVAL_MS = 60_000;
const MAX_HANDLED_IDS = 5_000;

interface ReminderState {
  schemaVersion: 1;
  handledIds: string[];
}

export type DesktopReminderNotifier = (
  reminder: RecruitmentReminder,
) => void | Promise<void>;

export class DesktopReminderService {
  private timer?: ReturnType<typeof setInterval>;
  private checking?: Promise<void>;

  constructor(
    private readonly loadRecords: () => Promise<ApplicationRecord[]>,
    private readonly statePath: string,
    private readonly notifier: DesktopReminderNotifier,
    private readonly now: () => number = Date.now,
    private readonly isEnabled: () => boolean | Promise<boolean> = () => true,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.checkNow().catch(error => console.error('桌面提醒检查失败', error));
    this.timer = setInterval(() => {
      void this.checkNow().catch(error => console.error('桌面提醒检查失败', error));
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async checkNow(): Promise<void> {
    if (this.checking) return this.checking;
    this.checking = this.performCheck().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async performCheck(): Promise<void> {
    if (!await this.isEnabled()) return;
    const reminders = buildRecruitmentReminders(await this.loadRecords());
    const state = await readReminderState(this.statePath);
    const handled = new Set(state.handledIds);
    let changed = false;
    for (const group of selectDueReminderGroups(reminders, handled, this.now())) {
      await this.notifier(group.reminder);
      group.handledIds.forEach(id => handled.add(id));
      changed = true;
    }
    const activeIds = new Set(reminders.map(reminder => reminder.id));
    const retained = [...handled].filter(id => activeIds.has(id)).slice(-MAX_HANDLED_IDS);
    if (retained.length !== state.handledIds.length) changed = true;
    if (changed) await writeReminderState(this.statePath, retained);
  }
}

async function readReminderState(path: string): Promise<ReminderState> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<ReminderState>;
    return {
      schemaVersion: 1,
      handledIds: Array.isArray(value.handledIds)
        ? value.handledIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
        : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('桌面提醒状态读取失败，将重新建立状态', error);
    }
    return { schemaVersion: 1, handledIds: [] };
  }
}

async function writeReminderState(path: string, handledIds: string[]): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, JSON.stringify({ schemaVersion: 1, handledIds }, null, 2), 'utf8');
  await rename(temporaryPath, path);
}
