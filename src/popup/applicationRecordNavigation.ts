import { MessageService } from '../shared/message';

const APPLICATION_RECORDS_PAGE = 'src/application-records/index.html';

export function getRuntimeUrl(path: string): string {
  return typeof chrome !== 'undefined' ? chrome.runtime.getURL(path) : path;
}

export async function openApplicationRecordCreateWindow(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('没有可用的当前页面');

  const draftResponse = await MessageService.sendMessage<{ draftId: string }>({
    type: 'CREATE_APPLICATION_RECORD_DRAFT',
    payload: { tabId: tab.id },
  });
  if (!draftResponse.success || !draftResponse.data?.draftId) {
    throw new Error(draftResponse.error || '无法创建投递记录草稿');
  }

  await chrome.windows.create({
    url: getRuntimeUrl(`${APPLICATION_RECORDS_PAGE}?draftId=${encodeURIComponent(draftResponse.data.draftId)}`),
    type: 'popup',
    width: 520,
    height: 760,
    focused: true,
  });
}

export async function openApplicationRecordOptions(): Promise<void> {
  await chrome.tabs.create({
    url: getRuntimeUrl('src/options/index.html?tab=application-records'),
  });
}
