import {
  RECRUITMENT_MAIL_CATEGORY,
  type MailClassification,
  type MailHeader,
  type MailHeaderFilterResult,
  type NormalizedEmail,
  type RecruitmentMailCategory,
} from './types.ts';

interface CategoryRule {
  category: RecruitmentMailCategory;
  subject: readonly RegExp[];
  body: readonly RegExp[];
}

const NON_RECRUITING_PATTERNS = [
  /\bjob alerts?\b/i,
  /\bjobs? you may (?:like|be interested in)\b/i,
  /\bweekly (?:jobs?|career) digest\b/i,
  /职位推荐|岗位推荐|每周职位|订阅职位|招聘资讯|求职课程/,
] as const;

const RECRUITING_SENDER_PATTERNS = [
  /(?:^|[.@_-])(career|careers|recruit|recruiting|talent|hiring|hr)(?:[.@_-]|$)/i,
  /(?:workday|greenhouse|lever|smartrecruiters|successfactors|ashbyhq|myworkdayjobs)/i,
] as const;

const GENERIC_RECRUITING_PATTERNS = [
  /\b(application|candidate|interview|assessment|recruiter|hiring|position|vacancy|offer)\b/i,
  /申请|应聘|候选人|面试|笔试|测评|招聘|录用|职位|岗位|校招/,
] as const;

const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    category: RECRUITMENT_MAIL_CATEGORY.REJECTION,
    subject: [
      /not (?:be )?(?:moving|progressing|proceeding) forward/i,
      /unsuccessful|regret to inform/i,
      /未通过|不合适|遗憾通知|不予录用|淘汰/,
    ],
    body: [
      /(?:regret|sorry).{0,80}(?:not|unable).{0,80}(?:move|progress|proceed)/i,
      /(?:decided|chosen).{0,80}(?:other|another) candidate/i,
      /will not be (?:moving|progressing|proceeding)/i,
      /很遗憾.{0,80}(?:未通过|无法进入|不再推进|其他候选人)/,
      /暂不匹配|未能通过|不予录用|淘汰/,
    ],
  },
  {
    category: RECRUITMENT_MAIL_CATEGORY.OFFER,
    subject: [/\boffer(?: letter)?\b/i, /录用通知|拟录用|入职邀请|校招录用/],
    body: [
      /(?:pleased|delighted|happy) to (?:extend|offer)/i,
      /offer you (?:the|a) (?:role|position)/i,
      /正式录用|拟录用|录用意向|入职材料|薪酬方案/,
    ],
  },
  {
    category: RECRUITMENT_MAIL_CATEGORY.INTERVIEW_INVITE,
    subject: [
      /\binterview (?:invitation|schedule|request|confirmation)\b/i,
      /面试邀请|面试通知|面试安排|面谈邀请|面试邀约|AI\s*面(?:试)?|智能面试|数字人面试/,
    ],
    body: [
      /(?:invite|schedule|confirm).{0,80}(?:you.{0,20})?interview/i,
      /\binterview\b.{0,80}(?:scheduled|date|time|on\b|[:：])/i,
      /面试(?:时间|安排|邀请|通知)|邀请.{0,40}参加.{0,20}面试/,
    ],
  },
  {
    category: RECRUITMENT_MAIL_CATEGORY.ASSESSMENT_INVITE,
    subject: [
      /\b(?:online |coding )?(?:assessment|test|challenge)\b/i,
      /笔试|在线测评|人才测评|编程测试|测评(?:邀请|通知|安排)?/,
    ],
    body: [
      /(?:complete|take).{0,60}(?:assessment|coding test|online test|challenge)/i,
      /请.{0,40}(?:完成|参加).{0,30}(?:笔试|测评|在线测试|编程测试)/,
    ],
  },
  {
    category: RECRUITMENT_MAIL_CATEGORY.APPLICATION_RECEIVED,
    subject: [
      /application (?:received|submitted|confirmation)/i,
      /thank you for (?:your )?(?:application|applying)/i,
      /申请已收到|简历已收到|投递成功|申请成功|投递确认/,
    ],
    body: [
      /(?:received|reviewing).{0,80}(?:your )?application/i,
      /thank you for applying/i,
      /(?:已收到|正在审核).{0,40}(?:申请|简历)|投递成功/,
    ],
  },
  {
    category: RECRUITMENT_MAIL_CATEGORY.JOB_CLOSED,
    subject: [/position (?:has been |is )?(?:closed|cancelled|canceled|filled)/i, /职位(?:已)?关闭|岗位取消|招聘终止/],
    body: [
      /position.{0,60}(?:no longer available|closed|cancelled|canceled|filled)/i,
      /(?:职位|岗位).{0,40}(?:已关闭|已取消|停止招聘|招聘终止)/,
    ],
  },
  {
    category: RECRUITMENT_MAIL_CATEGORY.RECRUITER_MESSAGE,
    subject: [/\b(?:career|job|role|position|opportunity)\b/i, /招聘沟通|职位机会|岗位机会|HR.{0,10}(?:沟通|联系)/i],
    body: [
      /(?:recruiter|talent acquisition|hiring team).{0,100}(?:role|position|opportunity)/i,
      /(?:招聘|人力资源|HR).{0,80}(?:岗位|职位|机会|沟通)/i,
    ],
  },
] as const;

export function filterRecruitmentHeader(header: MailHeader): MailHeaderFilterResult {
  const subject = compact(header.subject);
  const sender = compact(header.from);
  const reasons: string[] = [];
  const lifecycleHit = CATEGORY_RULES.some(rule =>
    rule.category !== RECRUITMENT_MAIL_CATEGORY.RECRUITER_MESSAGE
    && matchesAny(subject, rule.subject));
  const senderHit = matchesAny(sender, RECRUITING_SENDER_PATTERNS);
  const genericHit = matchesAny(subject, GENERIC_RECRUITING_PATTERNS);
  const promotional = matchesAny(subject, NON_RECRUITING_PATTERNS);

  if (promotional && !lifecycleHit) {
    return { candidate: false, confidence: 0.96, reasons: ['promotional-job-mail'] };
  }
  if (lifecycleHit) reasons.push('lifecycle-subject');
  if (senderHit) reasons.push('recruiting-sender');
  if (genericHit) reasons.push('recruiting-subject');

  const confidence = clamp01(
    (lifecycleHit ? 0.82 : 0)
    + (senderHit ? 0.12 : 0)
    + (genericHit ? 0.06 : 0),
  );
  return { candidate: lifecycleHit || senderHit || genericHit, confidence, reasons };
}

export function classifyRecruitmentEmail(email: NormalizedEmail): MailClassification {
  const headerResult = filterRecruitmentHeader({
    id: email.id,
    threadId: email.threadId,
    from: formatAddress(email.from),
    to: email.to,
    subject: email.subject,
    receivedAt: email.receivedAt,
  });
  const subject = compact(email.subject);
  const body = compact(`${email.text ?? ''}\n${stripHtml(email.html ?? '')}`).slice(0, 16_000);

  let best: MailClassification | undefined;
  for (const rule of CATEGORY_RULES) {
    const subjectHit = matchesAny(subject, rule.subject);
    const bodyHit = matchesAny(body, rule.body);
    if (!subjectHit && !bodyHit) continue;

    const senderHit = matchesAny(email.from.address, RECRUITING_SENDER_PATTERNS);
    const confidence = clamp01(
      (subjectHit ? 0.84 : 0)
      + (bodyHit ? (subjectHit ? 0.10 : 0.78) : 0)
      + (senderHit ? 0.05 : 0),
    );
    const reasons = [
      ...(subjectHit ? [`${rule.category}:subject`] : []),
      ...(bodyHit ? [`${rule.category}:body`] : []),
      ...(senderHit ? ['recruiting-sender'] : []),
    ];
    if (!best || confidence > best.classificationConfidence) {
      best = { category: rule.category, classificationConfidence: confidence, reasons };
    }
  }

  if (best) return best;
  if (matchesAny(subject, NON_RECRUITING_PATTERNS)) {
    return {
      category: RECRUITMENT_MAIL_CATEGORY.NOT_RECRUITING,
      classificationConfidence: 0.96,
      reasons: ['promotional-job-mail'],
    };
  }
  if (headerResult.candidate) {
    return {
      category: RECRUITMENT_MAIL_CATEGORY.UNKNOWN,
      classificationConfidence: Math.min(0.69, Math.max(0.35, headerResult.confidence)),
      reasons: headerResult.reasons,
    };
  }
  return {
    category: RECRUITMENT_MAIL_CATEGORY.NOT_RECRUITING,
    classificationConfidence: 0.98,
    reasons: ['no-recruiting-signal'],
  };
}

function compact(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function matchesAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(value));
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function formatAddress(address: NormalizedEmail['from']): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}
