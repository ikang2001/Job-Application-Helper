export const DEFAULT_REMINDER_CHECK_MINUTES = 5;
export const MAX_REMINDER_CHECK_MINUTES = 60;

export function isReminderCheckMinutes(value) {
  return Number.isInteger(value) && value >= DEFAULT_REMINDER_CHECK_MINUTES
    && value <= MAX_REMINDER_CHECK_MINUTES && value % DEFAULT_REMINDER_CHECK_MINUTES === 0;
}

export function normalizeReminderCheckMinutes(value) {
  return isReminderCheckMinutes(value) ? value : DEFAULT_REMINDER_CHECK_MINUTES;
}

export function isReminderCheckDue(value, now) {
  const interval = normalizeReminderCheckMinutes(value);
  // 按绝对时间分桶，不写入“上次检查时间”，避免为节流额外消耗 KV 写额度。
  return Math.floor(now / (DEFAULT_REMINDER_CHECK_MINUTES * 60_000))
    % (interval / DEFAULT_REMINDER_CHECK_MINUTES) === 0;
}
