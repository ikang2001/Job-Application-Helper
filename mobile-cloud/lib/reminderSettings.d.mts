export const DEFAULT_REMINDER_CHECK_MINUTES: 5;
export const MAX_REMINDER_CHECK_MINUTES: 60;
export function isReminderCheckMinutes(value: unknown): value is number;
export function normalizeReminderCheckMinutes(value: unknown): number;
export function isReminderCheckDue(value: unknown, now: number): boolean;
