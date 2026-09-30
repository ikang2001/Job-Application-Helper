export {
  DEFAULT_REMINDER_CHECK_MINUTES,
  MAX_REMINDER_CHECK_MINUTES,
  isReminderCheckMinutes,
  normalizeReminderCheckMinutes,
} from '../../../mobile-cloud/lib/reminderSettings.mjs';

export const DEFAULT_MAIL_SCAN_MINUTES = 15;
export const MAX_MAIL_SCAN_MINUTES = 120;

export function isMailScanMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_MAIL_SCAN_MINUTES;
}

export function normalizeMailScanMinutes(value: unknown): number {
  return isMailScanMinutes(value) ? value : DEFAULT_MAIL_SCAN_MINUTES;
}
