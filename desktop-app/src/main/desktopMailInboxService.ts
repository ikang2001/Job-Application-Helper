import { createHash } from 'node:crypto';
import { filterRecruitmentHeader, classifyRecruitmentEmail } from '../../../src/services/mail/classifier.ts';
import { extractRecruitmentData } from '../../../src/services/mail/extractor.ts';
import type { NormalizedEmail } from '../../../src/services/mail/types.ts';
import {
  matchDesktopMailCompany,
  suggestedDesktopMailStage,
} from '../domain/desktopMail.ts';
import type {
  DesktopMailAccountState,
  DesktopMailReview,
  DesktopMailReviewStage,
} from '../shared/contracts.ts';
import type { DesktopData, StoredDesktopMailInbox } from './desktopStore.ts';
import {
  type DesktopNativeMailAccount,
  type DesktopNativeMailHeader,
  type DesktopNativeMailMessage,
  type DesktopNativeMailPort,
} from './desktopNativeMailClient.ts';

const SCAN_INTERVAL_MS = 15 * 60 * 1000;
const INITIAL_SCAN_DELAY_MS = 2_000;
const FIRST_SCAN_DAYS = 30;
const PAGE_LIMIT = 40;
const MAX_PAGES_PER_SCAN = 4;
const MAX_STORED_REVIEWS = 500;
const SCHEDULED_REVIEW_STAGES = new Set<DesktopMailReviewStage>([
  'writtenTest', 'assessment', 'ai', 'first', 'second', 'third', 'hr',
]);

export class DesktopMailInboxService {
  private initialTimer?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;

  constructor(private readonly client: DesktopNativeMailPort) {}

  start(scan: () => void): void {
    this.stop();
    this.initialTimer = setTimeout(scan, INITIAL_SCAN_DELAY_MS);
    this.interval = setInterval(scan, SCAN_INTERVAL_MS);
  }

  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.interval) clearInterval(this.interval);
    this.initialTimer = undefined;
    this.interval = undefined;
  }

  async scan(data: DesktopData): Promise<DesktopData> {
    const accounts = await this.client.listAccounts();
    const current = data.mailInbox ?? emptyInbox();
    if (!accounts.length) {
      return {
        ...data,
        mailInbox: {
          ...current,
          status: 'unavailable',
          accounts: [],
          lastError: '没有可用的本地邮箱账号，请先在 Edge 扩展中配置邮箱',
        },
      };
    }

    const cursors = { ...current.cursors };
    const discovered: DesktopMailReview[] = [];
    const accountStates: DesktopMailAccountState[] = [];
    let successfulAccounts = 0;

    for (const account of accounts) {
      try {
        await this.client.testConnection(account.id);
        await this.scanAccount(account, data, current, cursors, discovered);
        successfulAccounts += 1;
        accountStates.push(accountState(account, 'connected'));
      } catch (error) {
        accountStates.push(accountState(
          account,
          'error',
          error instanceof Error ? error.message : '邮箱扫描失败',
        ));
      }
    }

    const mergedReviews = mergeReviews(current.reviews, discovered);
    const failures = accountStates.filter(account => account.connection === 'error');
    const lastError = failures.length
      ? failures.map(account => `${account.emailAddress}：${account.lastError}`).join('；')
      : undefined;
    return {
      ...data,
      mailInbox: {
        status: successfulAccounts > 0 ? 'idle' : 'error',
        accounts: accountStates,
        reviews: mergedReviews,
        cursors,
        lastScannedAt: new Date().toISOString(),
        lastError,
      },
    };
  }

  private async scanAccount(
    account: DesktopNativeMailAccount,
    data: DesktopData,
    current: StoredDesktopMailInbox,
    cursors: StoredDesktopMailInbox['cursors'],
    discovered: DesktopMailReview[],
  ): Promise<void> {
    let cursor = cursors[account.id];
    const since = cursor ? undefined : new Date(Date.now() - FIRST_SCAN_DAYS * 86_400_000).toISOString();
    for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_SCAN; pageIndex += 1) {
      const page = await this.client.listMessages(account.id, {
        cursor,
        since,
        limit: PAGE_LIMIT,
      });
      const headers = page.messages.filter(header => (
        headerIsCandidate(header)
        || matchDesktopMailCompany(headerText(header), undefined, data.records).recordIds.length > 0
      ));
      const messages = await mapWithConcurrency(headers, 3, header => (
        this.client.getMessage(account.id, header.id)
      ));
      for (const message of messages) {
        const review = buildReview(account, message, data, current.reviews);
        if (review) discovered.push(review);
      }
      cursor = page.cursor;
      cursors[account.id] = cursor;
      if (!page.hasMore) break;
    }
  }
}

function buildReview(
  account: DesktopNativeMailAccount,
  message: DesktopNativeMailMessage,
  data: DesktopData,
  existing: readonly DesktopMailReview[],
): DesktopMailReview | undefined {
  const email: NormalizedEmail = {
    id: message.id,
    accountId: account.id,
    provider: 'imap',
    from: message.from,
    to: message.to,
    subject: message.subject,
    receivedAt: message.receivedAt,
    text: message.text,
  };
  const extracted = extractRecruitmentData(email);
  const classification = classifyRecruitmentEmail(email);
  const content = `${message.subject}\n${message.from.name ?? ''}\n${message.from.address}\n${message.text}`;
  const companyMatch = matchDesktopMailCompany(content, extracted.companyName, data.records);
  const suggestedStage = suggestedDesktopMailStage(classification.category, content, message.subject);
  if (
    !hasScheduledRecruitmentArrangement(message.subject, message.text)
    || !suggestedStage
    || !SCHEDULED_REVIEW_STAGES.has(suggestedStage)
  ) return undefined;

  const id = reviewId(account.id, message.id);
  const previous = existing.find(review => review.id === id);
  return {
    id,
    accountId: account.id,
    messageId: message.id,
    from: message.from.name
      ? `${message.from.name} <${message.from.address}>`
      : message.from.address,
    subject: message.subject || '无主题邮件',
    receivedAt: message.receivedAt,
    summary: compact(message.text).slice(0, 1_600),
    category: classification.category,
    suggestedStage,
    companyName: companyMatch.companyName,
    candidateRecordIds: companyMatch.recordIds,
    extractedAt: suggestedStage === 'writtenTest' || suggestedStage === 'assessment'
      ? extracted.scheduledAt
      : extracted.interviewAt,
    deadlineAt: extracted.deadlineAt,
    actionUrl: extracted.meetingUrl ?? extractActionUrl(message.text),
    state: previous?.state ?? 'pending',
    reviewedAt: previous?.reviewedAt,
    selectedRecordId: previous?.selectedRecordId,
    selectedStage: previous?.selectedStage,
  };
}

function hasScheduledRecruitmentArrangement(subject: string, body: string): boolean {
  const normalizedSubject = compact(subject);
  const scheduleTerm = /测评|笔试|面试|assessment|coding\s*(?:test|challenge)|interview/i;
  const acknowledgement = /(?:感谢|已收到|成功).{0,16}(?:投递|申请|简历)|(?:投递|申请).{0,16}(?:成功|确认)/i;
  if (acknowledgement.test(normalizedSubject) && !scheduleTerm.test(normalizedSubject)) return false;

  const content = compact(`${subject}\n${body}`);
  return /(?:请|邀请|邀约|安排|参加|完成|开始|预约|进入).{0,40}(?:测评|笔试|面试)/i.test(content)
    || /(?:测评|笔试|面试).{0,40}(?:邀请|邀约|通知|安排|时间|链接|地址|截止|参加|完成|开始|预约)/i.test(content)
    || /\b(?:please|invited?|schedule[ds]?|complete|attend|start|book)\b.{0,80}\b(?:assessment|coding\s*(?:test|challenge)|interview)\b/i.test(content)
    || /\b(?:assessment|coding\s*(?:test|challenge)|interview)\b.{0,80}\b(?:invitation|invite|schedule|time|link|deadline|complete|attend|start|book)\b/i.test(content);
}

function headerIsCandidate(header: DesktopNativeMailHeader): boolean {
  return filterRecruitmentHeader({
    id: header.id,
    from: header.from.name ? `${header.from.name} <${header.from.address}>` : header.from.address,
    to: header.to,
    subject: header.subject,
    receivedAt: header.receivedAt,
  }).candidate;
}

function headerText(header: DesktopNativeMailHeader): string {
  return `${header.subject}\n${header.from.name ?? ''}\n${header.from.address}`;
}

function accountState(
  account: DesktopNativeMailAccount,
  connection: DesktopMailAccountState['connection'],
  lastError?: string,
): DesktopMailAccountState {
  return {
    id: account.id,
    provider: account.provider,
    emailAddress: account.emailAddress,
    displayName: account.displayName ?? '',
    connection,
    lastError,
  };
}

function mergeReviews(
  existing: readonly DesktopMailReview[],
  discovered: readonly DesktopMailReview[],
): DesktopMailReview[] {
  const byId = new Map(existing.map(review => [review.id, review]));
  for (const review of discovered) {
    const current = byId.get(review.id);
    byId.set(review.id, current?.state === 'pending' || !current ? review : current);
  }
  return [...byId.values()]
    .sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt))
    .slice(0, MAX_STORED_REVIEWS);
}

function reviewId(accountId: string, messageId: string): string {
  return `mail_${createHash('sha256').update(`${accountId}\0${messageId}`).digest('hex').slice(0, 24)}`;
}

function extractActionUrl(text: string): string | undefined {
  const urls = text.match(/https:\/\/[^\s<>()"']+/gi) ?? [];
  const cleaned = urls.map(url => url.replace(/[.,，。;；!?！？\]}]+$/g, ''));
  return cleaned.find(url => !/unsubscribe|退订|privacy|隐私|tracking/i.test(url));
}

function compact(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function emptyInbox(): StoredDesktopMailInbox {
  return { status: 'idle', accounts: [], reviews: [], cursors: {} };
}

async function mapWithConcurrency<T, R>(
  input: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(input.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, input.length) }, async () => {
    while (nextIndex < input.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(input[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
