export const MAIL_RETRY_ALARM_PREFIX = 'job-application-helper-mail-retry:';

export async function scheduleMailRetry(accountId: string, retryAt: string): Promise<void> {
  const alarms = typeof chrome !== 'undefined' ? chrome.alarms : undefined;
  if (!alarms || !Number.isFinite(Date.parse(retryAt))) return;
  const name = `${MAIL_RETRY_ALARM_PREFIX}${encodeURIComponent(accountId)}`;
  const when = Math.max(Date.now() + 1_000, Date.parse(retryAt));
  const previous = await alarms.get(name);
  if (previous && Math.abs(previous.scheduledTime - when) < 1_000) return;
  await alarms.create(name, { when });
}

export async function clearMailRetry(accountId: string): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.alarms?.clear) {
    await chrome.alarms.clear(`${MAIL_RETRY_ALARM_PREFIX}${encodeURIComponent(accountId)}`);
  }
}

export async function restoreMailRetries(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.alarms || !chrome.storage?.local) return;
  const { mailAccounts } = await chrome.storage.local.get('mailAccounts');
  if (!Array.isArray(mailAccounts)) return;
  for (const account of mailAccounts) {
    if (account.enabled && typeof account.id === 'string' && typeof account.retryAt === 'string') {
      await scheduleMailRetry(account.id, account.retryAt);
    }
  }
}
