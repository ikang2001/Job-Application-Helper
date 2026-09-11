import { handleSyncMail } from './mailMonitor.ts';

export const MAIL_SCAN_ALARM_NAME = 'job-application-helper-mail-scan';
export const MAIL_SCAN_PERIOD_MINUTES = 15;

export interface MailAlarmPort {
  get(name: string): Promise<chrome.alarms.Alarm | undefined>;
  create(name: string, info: chrome.alarms.AlarmCreateInfo): Promise<void> | void;
}

export async function ensureMailScanAlarm(alarms: MailAlarmPort): Promise<void> {
  if (await alarms.get(MAIL_SCAN_ALARM_NAME)) return;
  await alarms.create(MAIL_SCAN_ALARM_NAME, {
    delayInMinutes: MAIL_SCAN_PERIOD_MINUTES,
    periodInMinutes: MAIL_SCAN_PERIOD_MINUTES,
  });
}

export async function handleMailAlarm(alarm: Pick<chrome.alarms.Alarm, 'name'>): Promise<void> {
  if (alarm.name !== MAIL_SCAN_ALARM_NAME) return;
  const result = await handleSyncMail(undefined);
  const failures = result.data?.filter(account => account.error) ?? [];
  if (failures.length > 0) {
    console.warn(`[MailMonitor] ${failures.length} 个邮箱扫描失败`);
  }
}
