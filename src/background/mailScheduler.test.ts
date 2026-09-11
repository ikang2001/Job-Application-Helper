import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAIL_SCAN_ALARM_NAME,
  MAIL_SCAN_PERIOD_MINUTES,
  ensureMailScanAlarm,
} from './mailScheduler.ts';

test('alarm 不存在时按 15 分钟创建，存在时保持不变', async () => {
  const created: Array<{ name: string; info: chrome.alarms.AlarmCreateInfo }> = [];
  await ensureMailScanAlarm({
    get: async () => undefined,
    create: async (name, info) => { created.push({ name, info }); },
  });
  assert.deepEqual(created, [{
    name: MAIL_SCAN_ALARM_NAME,
    info: { delayInMinutes: MAIL_SCAN_PERIOD_MINUTES, periodInMinutes: MAIL_SCAN_PERIOD_MINUTES },
  }]);

  await ensureMailScanAlarm({
    get: async () => ({ name: MAIL_SCAN_ALARM_NAME, scheduledTime: Date.now() }),
    create: async () => { throw new Error('不应重建'); },
  });
});
