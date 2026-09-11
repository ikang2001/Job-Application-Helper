import type { MessageResponse } from '../shared/types';

const PAGE_FOCUS_WAIT_LIMIT_MS = 800;
const PAGE_FOCUS_POLL_MS = 40;

function scheduleAfterPageFocus(task: () => void): void {
  const startedAt = Date.now();
  const attempt = () => {
    const focusKnown = typeof document !== 'undefined'
      && typeof document.hasFocus === 'function';
    if (!focusKnown || document.hasFocus() || Date.now() - startedAt >= PAGE_FOCUS_WAIT_LIMIT_MS) {
      task();
      return;
    }
    setTimeout(attempt, PAGE_FOCUS_POLL_MS);
  };
  setTimeout(attempt, 120);
}

/** 先回应启动请求，让扩展弹窗关闭并归还页面焦点，再运行网页交互。 */
export function createPageFillTaskRunner(
  schedule: (task: () => void) => void = scheduleAfterPageFocus,
  onError: (error: unknown) => void = error => { console.error('Page fill task failed:', error); },
) {
  let running = false;
  return (task: () => Promise<unknown>): MessageResponse => {
    if (running) return { success: false, error: '当前页面正在填充，请等待本次完成' };
    running = true;
    schedule(() => {
      void Promise.resolve().then(task).catch(onError).finally(() => { running = false; });
    });
    return { success: true };
  };
}
