import type { ExtractedRecruitmentData, NormalizedEmail } from './types.ts';

const GENERIC_SENDER_DOMAINS = new Set([
  'workday',
  'myworkdayjobs',
  'greenhouse',
  'greenhouse-mail',
  'lever',
  'smartrecruiters',
  'successfactors',
  'ashbyhq',
  'ibeisen',
  'gmail',
  'outlook',
  'hotmail',
  'qq',
]);

export function extractRecruitmentData(email: NormalizedEmail): ExtractedRecruitmentData {
  const text = normalizedText(email);
  const companyName = firstCapture(text, [
    /(?:company|employer|organization)\s*(?:name)?\s*[:：]\s*([^\n\r|]{2,80})/i,
    /(?:公司|企业)(?:名称)?\s*[:：]\s*([^\n\r|]{2,80})/,
  ]) ?? companyFromSubject(email.subject) ?? companyFromSender(email.from.address);
  const jobTitle = firstCapture(text, [
    /(?:job\s*title|position|role)\s*[:：]\s*([^\n\r|]{2,100})/i,
    /(?:职位|岗位)(?:名称)?\s*[:：]\s*([^\n\r|]{2,100})/,
    /(?:application|interview|assessment)\s+for\s+(?:the\s+)?([^\n\r|]{2,100}?)(?:\s+(?:role|position))?(?:[.!。]|$)/i,
  ]);
  const jobId = firstCapture(text, [
    /(?:job|position|requisition|req)\s*(?:id|number|no\.?|#)\s*[:：#-]?\s*([A-Z0-9][A-Z0-9._/-]{1,80})/i,
    /(?:职位|岗位|招聘)(?:编号|ID)\s*[:：#-]?\s*([A-Z0-9][A-Z0-9._/-]{1,80})/i,
  ]);
  const applicationId = firstCapture(text, [
    /(?:application|candidate)\s*(?:id|number|no\.?|#)\s*[:：#-]?\s*([A-Z0-9][A-Z0-9._/-]{1,80})/i,
    /(?:申请|应聘)(?:编号|ID)\s*[:：#-]?\s*([A-Z0-9][A-Z0-9._/-]{1,80})/i,
  ]);
  const scheduledAt = extractLabeledDate(text, /笔试|考试(?:开始)?时间|测评(?:开始)?时间/i);
  const interviewAt = extractLabeledDate(text, /interview|面试|面谈/i);
  const deadlineAt = extractDeadline(text, email.receivedAt);
  const meetingUrl = extractMeetingUrl(text);
  const summary = compact(text).slice(0, 500) || undefined;

  return compactFields({
    companyName,
    jobTitle,
    jobId,
    applicationId,
    scheduledAt,
    interviewAt,
    deadlineAt,
    meetingUrl,
    summary,
  });
}

function normalizedText(email: NormalizedEmail): string {
  const htmlText = (email.html ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
  return `${email.subject}\n${email.text ?? ''}\n${htmlText}`.normalize('NFKC').slice(0, 40_000);
}

function firstCapture(value: string, patterns: readonly RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = value.match(pattern)?.[1];
    if (match) return cleanCapturedValue(match);
  }
  return undefined;
}

function cleanCapturedValue(value: string): string {
  return value.replace(/^["'“”‘’\s]+|["'“”‘’\s,，;；.。]+$/g, '').trim();
}

function companyFromSubject(subject: string): string | undefined {
  const bracket = subject.match(/^[【[]([^\]】]{2,60})[\]】]/)?.[1];
  if (bracket && !/招聘|申请|面试|笔试|测评|offer|career/i.test(bracket)) {
    return cleanCapturedValue(bracket);
  }
  const chineseCompany = firstCapture(subject, [
    /[—–-]+\s*([^\n\r|—–-]{2,60}?)(?=\s*(?:20\d{2}届)?(?:校园)?招聘)/i,
    /来自\s*([^\n\r|]{2,60}?)\s*的(?:在线)?(?:测评|笔试|面试)(?:邀请|通知|安排|提醒)/i,
    /^(?!在线(?:测评|笔试|面试))([^\n\r|—–-]{2,60}?)(?=\s*(?:20\d{2}届)?(?:校园招聘)?(?:在线)?(?:测评|笔试|面试)(?:邀请|通知|安排|提醒))/i,
  ]);
  if (chineseCompany) return cleanCapturedValue(chineseCompany);
  const atCompany = subject.match(/\b(?:at|with)\s+([A-Z][A-Za-z0-9&.' -]{1,60})(?:\s*[-–—|]|$)/)?.[1];
  return atCompany ? cleanCapturedValue(atCompany) : undefined;
}

function companyFromSender(address: string): string | undefined {
  const hostname = address.split('@')[1]?.toLowerCase();
  if (!hostname) return undefined;
  const labels = hostname.split('.').filter(Boolean);
  if (labels.length < 2) return undefined;
  const publicSuffix = labels.slice(-2).join('.');
  const hasCompoundSuffix = new Set(['co.uk', 'com.cn', 'com.hk', 'com.au']).has(publicSuffix);
  const candidate = hasCompoundSuffix ? labels.at(-3) : labels.at(-2);
  if (!candidate || GENERIC_SENDER_DOMAINS.has(candidate)) return undefined;
  return candidate.replace(/[-_]+/g, ' ');
}

function extractLabeledDate(text: string, label: RegExp): string | undefined {
  const dateSource = '(\\d{4})[-/.年](\\d{1,2})[-/.月](\\d{1,2})(?:日)?(?:\\s*(?:周|星期)[一二三四五六日天])?(?:[ T，,]*(\\d{1,2})[:：](\\d{2})(?::\\d{2})?)?';
  const forward = new RegExp(`(?:${label.source})[^\\n\\r]{0,100}?${dateSource}`, label.flags);
  const match = text.match(forward);
  return match ? dateFromMatch(match) : undefined;
}

function extractDeadline(text: string, receivedAt: string): string | undefined {
  const label = /deadline|complete by|due by|截止|失效|到期|有效期(?:至|到)|请于.*前/i;
  return extractDateBeforeLabel(text, label)
    ?? extractLabeledDate(text, label)
    ?? extractRelativeDeadline(text, receivedAt);
}

function extractDateBeforeLabel(text: string, label: RegExp): string | undefined {
  const dateSource = '(\\d{4})[-/.年](\\d{1,2})[-/.月](\\d{1,2})(?:日)?(?:\\s*(?:周|星期)[一二三四五六日天])?(?:[ T，,]*(\\d{1,2})[:：](\\d{2})(?::\\d{2})?)?';
  const reverse = new RegExp(`${dateSource}[^\\d\\n\\r]{0,24}(?:${label.source})`, label.flags);
  const match = text.match(reverse);
  return match ? dateFromMatch(match) : undefined;
}

function extractRelativeDeadline(text: string, receivedAt: string): string | undefined {
  const match = text.match(/(?:收到(?:本)?邮件(?:后)?|自(?:邮件)?发送(?:后)?|请|须|需|务必)?[^\n\r]{0,30}?(\d{1,3})\s*(小时|天|日)(?:之内|以内|内)/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const received = Date.parse(receivedAt);
  if (!Number.isInteger(amount) || amount < 1 || amount > 365 || !Number.isFinite(received)) return undefined;
  const duration = amount * (match[2] === '小时' ? 3_600_000 : 86_400_000);
  return new Date(received + duration).toISOString();
}

function dateFromMatch(match: RegExpMatchArray): string | undefined {
  const [year, month, day, hour, minute] = match.slice(1, 6);
  const yyyy = year?.padStart(4, '0');
  const mm = month?.padStart(2, '0');
  const dd = day?.padStart(2, '0');
  if (!yyyy || !mm || !dd || !isValidDateParts(Number(yyyy), Number(mm), Number(dd))) return undefined;
  if (hour === undefined || minute === undefined) return `${yyyy}-${mm}-${dd}`;
  const hh = hour.padStart(2, '0');
  if (Number(hh) > 23 || Number(minute) > 59) return undefined;
  return `${yyyy}-${mm}-${dd}T${hh}:${minute}:00`;
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function extractMeetingUrl(text: string): string | undefined {
  const urls = text.match(/https:\/\/[^\s<>()"']+/gi) ?? [];
  return urls
    .map(url => url.replace(/[.,，。;；!?！？\]}]+$/g, ''))
    .find(url => /(?:zoom\.us|teams\.microsoft\.com|meet\.google\.com|meeting|interview)/i.test(url));
}

function compactFields(value: ExtractedRecruitmentData): ExtractedRecruitmentData {
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => [key, typeof entry === 'string' ? compact(entry) : entry])
      .filter(([, entry]) => entry !== undefined && entry !== ''),
  );
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
