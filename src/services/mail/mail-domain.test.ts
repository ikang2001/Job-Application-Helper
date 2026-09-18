import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRecruitmentEmail, filterRecruitmentHeader } from './classifier.ts';
import { appendUniqueBySourceKey, buildMailSourceKey, hasProcessedMailMessage } from './dedup.ts';
import { extractRecruitmentData } from './extractor.ts';
import { scanMailPage } from './mailService.ts';
import { decideMailAction, matchEmailToApplication } from './matcher.ts';
import type { MailProvider } from './provider.ts';
import {
  MAIL_PROVIDER,
  RECRUITMENT_MAIL_CATEGORY,
  type MailHeader,
  type NormalizedEmail,
} from './types.ts';

const interviewEmail: NormalizedEmail = {
  id: 'message-1',
  threadId: 'thread-1',
  accountId: 'account@example.com',
  provider: MAIL_PROVIDER.GMAIL,
  from: { name: 'Acme Recruiting', address: 'recruiting@acme.com' },
  to: ['candidate@example.com'],
  subject: 'Interview invitation for Software Engineer at Acme',
  receivedAt: '2026-09-01T08:00:00.000Z',
  text: [
    'Company: Acme Inc.',
    'Position: Software Engineer',
    'Job ID: REQ-1234',
    'Application ID: APP-9876',
    'Interview: 2026-09-10 14:30',
    'Please join https://teams.microsoft.com/l/meetup-join/example.',
  ].join('\n'),
};

test('header filter rejects job digests but keeps lifecycle mail', () => {
  const digest: MailHeader = {
    id: 'digest',
    from: 'alerts@example.com',
    to: ['candidate@example.com'],
    subject: 'Your weekly job alert: 12 new jobs for you',
    receivedAt: '2026-09-01T00:00:00.000Z',
  };
  assert.equal(filterRecruitmentHeader(digest).candidate, false);
  assert.equal(filterRecruitmentHeader({
    ...digest,
    id: 'interview',
    from: 'recruiting@acme.com',
    subject: 'Interview invitation - Software Engineer',
  }).candidate, true);
});

test('classifier and extractor produce deterministic recruitment structure', () => {
  const classification = classifyRecruitmentEmail(interviewEmail);
  assert.equal(classification.category, RECRUITMENT_MAIL_CATEGORY.INTERVIEW_INVITE);
  assert.ok(classification.classificationConfidence >= 0.9);

  assert.deepEqual(extractRecruitmentData(interviewEmail), {
    companyName: 'Acme Inc',
    jobTitle: 'Software Engineer',
    jobId: 'REQ-1234',
    applicationId: 'APP-9876',
    interviewAt: '2026-09-10T14:30:00',
    meetingUrl: 'https://teams.microsoft.com/l/meetup-join/example',
    summary: 'Interview invitation for Software Engineer at Acme Company: Acme Inc. '
      + 'Position: Software Engineer Job ID: REQ-1234 Application ID: APP-9876 '
      + 'Interview: 2026-09-10 14:30 Please join https://teams.microsoft.com/l/meetup-join/example.',
  });
});

test('extractor recognizes absolute expiry and relative completion deadlines', () => {
  const absolute = extractRecruitmentData({
    ...interviewEmail,
    subject: '在线测评邀请',
    text: '本次测试邀请于2026-09-10 13:47:00生效，于2026-09-24 13:47:00失效。',
  });
  assert.equal(absolute.deadlineAt, '2026-09-24T13:47:00');

  const relative = extractRecruitmentData({
    ...interviewEmail,
    subject: 'AI 面试邀请',
    receivedAt: '2026-09-10T06:00:00.000Z',
    text: '请在收到邮件后24小时内完成 AI 面试。',
  });
  assert.equal(relative.deadlineAt, '2026-09-11T06:00:00.000Z');

  const spacedRelative = extractRecruitmentData({
    ...interviewEmail,
    subject: '人才测评通知',
    receivedAt: '2026-09-15T06:15:34.000Z',
    text: '现邀请您参加在线测评，请在收到通知的 3 天 内 完成测评。',
  });
  assert.equal(spacedRelative.deadlineAt, '2026-09-18T06:15:34.000Z');

  const linkValidity = extractRecruitmentData({
    ...interviewEmail,
    subject: '【星桥创新校招测评】2027届校园招聘',
    receivedAt: '2026-09-11T06:00:00.000Z',
    text: '请用简历中的姓名、邮箱完成认证;链接有效期5天,请合理安排时间。',
  });
  assert.equal(linkValidity.deadlineAt, '2026-09-16T06:00:00.000Z');

  const deadlineBeforeCompletion = extractRecruitmentData({
    ...interviewEmail,
    subject: '三一集团校园招聘 AI 测评通知',
    receivedAt: '2026-09-11T13:00:49.000Z',
    text: '请您在收到本邮件后，合理安排时间，并于 2026-09-18 23:59 前完成测评。',
  });
  assert.equal(deadlineBeforeCompletion.deadlineAt, '2026-09-18T23:59:00');

  const validityWindow = extractRecruitmentData({
    ...interviewEmail,
    subject: '在线测评邀请——远航控股2027届校园招聘',
    text: '本次测试邀请于2026年09月10日 周四 18:08生效，于2026年09月17日 周四 18:08失效。远航控股 2026年09月10日',
  });
  assert.equal(validityWindow.deadlineAt, '2026-09-17T18:08:00');
});

test('extractor reads the employer name from Chinese assessment subjects before platform domains', () => {
  const extracted = extractRecruitmentData({
    ...interviewEmail,
    subject: '在线测评邀请——远航控股2027届校园招聘',
    from: { name: 'iTalent招聘助手', address: 'notice@shmail.ibeisen.com' },
    text: '请在规定时间内完成在线测评。',
  });

  assert.equal(extracted.companyName, '远航控股');
});

test('extractor reads the employer name from a Moka initial interview subject', () => {
  const extracted = extractRecruitmentData({
    ...interviewEmail,
    subject: '云枢2027届校园招聘业务初面邀请（邮件重要请仔细阅读）',
    from: { name: '云枢招聘', address: 'recruit@example.com' },
    text: '恭喜你通过线上笔试，我们诚挚邀请你参加业务初试。',
  });

  assert.equal(extracted.companyName, '云枢');
});

test('classifier recognizes plain Chinese assessment notices and AI interview invitations', () => {
  const assessment = classifyRecruitmentEmail({
    ...interviewEmail,
    id: 'assessment-cn',
    subject: '云帆技术2027届校园招聘测评通知',
    text: '请登录人才测评系统，在截止时间前完成。',
  });
  const aiInterview = classifyRecruitmentEmail({
    ...interviewEmail,
    id: 'ai-interview-cn',
    subject: '星河网络 AI面试邀约',
    text: '请按邮件说明完成智能面试。',
  });
  assert.equal(assessment.category, RECRUITMENT_MAIL_CATEGORY.ASSESSMENT_INVITE);
  assert.equal(aiInterview.category, RECRUITMENT_MAIL_CATEGORY.INTERVIEW_INVITE);
});

test('matcher keeps classification, match, and decision confidence separate', () => {
  const extracted = extractRecruitmentData(interviewEmail);
  const match = matchEmailToApplication(interviewEmail, extracted, [{
    id: 'record-1',
    companyName: 'Acme Inc.',
    jobTitle: 'Software Engineer',
    sourceSite: 'https://jobs.acme.com/roles/1234',
    appliedAt: '2026-08-25',
    jobId: 'req_1234',
    applicationId: 'app-9876',
    applicationEmail: 'candidate@example.com',
  }]);
  assert.equal(match.recordId, 'record-1');
  assert.equal(match.matchConfidence, 1);

  const decision = decideMailAction(classifyRecruitmentEmail(interviewEmail), match);
  assert.equal(decision.disposition, 'auto-update');
  assert.equal(decision.matchConfidence, 1);
  assert.ok(decision.classificationConfidence >= 0.9);
  assert.equal(decision.decisionConfidence, decision.classificationConfidence);
});

test('identifier conflicts prevent a company/title coincidence from updating the wrong record', () => {
  const match = matchEmailToApplication(interviewEmail, extractRecruitmentData(interviewEmail), [{
    id: 'wrong-record',
    companyName: 'Acme Inc.',
    jobTitle: 'Software Engineer',
    sourceSite: 'jobs.acme.com',
    appliedAt: '2026-08-25',
    jobId: 'REQ-9999',
  }]);
  assert.ok(match.matchConfidence < 0.75);
  assert.equal(decideMailAction(classifyRecruitmentEmail(interviewEmail), match).disposition, 'ignore');
});

test('ambiguous high matches are forced into pending review', () => {
  const records = ['record-a', 'record-b'].map(id => ({
    id,
    companyName: 'Acme Inc.',
    jobTitle: 'Software Engineer',
    sourceSite: 'jobs.acme.com',
    appliedAt: '2026-08-25',
    jobId: 'REQ-1234',
    applicationId: 'APP-9876',
    applicationEmail: 'candidate@example.com',
  }));
  const match = matchEmailToApplication(interviewEmail, extractRecruitmentData(interviewEmail), records);
  assert.equal(match.ambiguous, true);
  assert.equal(match.matchConfidence, 0.94);
  assert.equal(decideMailAction(classifyRecruitmentEmail(interviewEmail), match).disposition, 'pending-review');
});

test('source keys are stable, escaped, and appended idempotently', () => {
  const sourceKey = buildMailSourceKey('gmail', 'candidate:test@example.com', 'message:1', 'interview_invite');
  assert.equal(
    sourceKey,
    'email:gmail:candidate%3Atest%40example.com:message%3A1:interview_invite',
  );
  assert.equal(
    hasProcessedMailMessage('gmail', 'candidate:test@example.com', 'message:1', [sourceKey]),
    true,
  );
  assert.deepEqual(
    appendUniqueBySourceKey([{ sourceKey }], [{ sourceKey }, { sourceKey: 'email:gmail:a:m:offer' }]),
    [{ sourceKey }, { sourceKey: 'email:gmail:a:m:offer' }],
  );
});

test('mail service fetches bodies only for new header candidates and creates pending review', async () => {
  const headers: MailHeader[] = [
    {
      id: 'digest',
      from: 'alerts@example.com',
      to: ['candidate@example.com'],
      subject: 'Weekly job alert',
      receivedAt: '2026-09-01T08:00:00.000Z',
    },
    {
      id: 'duplicate',
      from: 'recruiting@acme.com',
      to: ['candidate@example.com'],
      subject: 'Interview invitation',
      receivedAt: '2026-09-01T08:00:00.000Z',
    },
    {
      id: 'candidate',
      from: 'recruiting@acme.com',
      to: ['candidate@example.com'],
      subject: 'Interview invitation',
      receivedAt: '2026-09-01T08:00:00.000Z',
    },
  ];
  const fetched: string[] = [];
  const provider: MailProvider = {
    kind: 'gmail',
    accountId: 'account@example.com',
    async testConnection() {
      return { connected: true, accountId: 'account@example.com' };
    },
    async listHeaders() {
      return { items: headers, syncCursor: 'gmail:checkpoint' };
    },
    async getMessage(id) {
      fetched.push(id);
      return {
        ...interviewEmail,
        id,
        subject: 'Interview invitation',
        text: 'Company: Acme\nPosition: Software Engineer\nWe invite you to interview.',
      };
    },
  };
  const duplicateKey = buildMailSourceKey(
    'gmail',
    'account@example.com',
    'duplicate',
    'interview_invite',
  );
  const result = await scanMailPage(provider, [{
    id: 'record-1',
    companyName: 'Acme',
    jobTitle: 'Software Engineer',
    sourceSite: 'jobs.acme.com',
    appliedAt: '2026-08-25',
    applicationEmail: 'candidate@example.com',
  }], {
    limit: 10,
    existingSourceKeys: [duplicateKey],
  });

  assert.deepEqual(fetched, ['candidate']);
  assert.equal(result.fetchedMessages, 1);
  assert.equal(result.skippedDuplicates, 1);
  assert.equal(result.pendingReviews.length, 1);
  assert.equal(result.candidates[0]?.decision.disposition, 'pending-review');
  assert.equal(result.syncCursor, 'gmail:checkpoint');
});
