import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MailAccountsSection } from './MailAccountsSection.tsx';

test('邮箱监控页展示 Gmail、Outlook、IMAP 和人工确认入口', () => {
  const html = renderToStaticMarkup(<MailAccountsSection
    initialAccounts={[{
      id: 'gmail-1', provider: 'gmail', emailAddress: 'candidate@gmail.com',
      enabled: true, connectionState: 'connected', oauthClientId: 'client-id',
    }]}
    initialReviews={[{
      id: 'review-1', sourceKey: 'email:gmail:account:message:interview_invite', state: 'pending',
      email: {
        id: 'message', accountId: 'gmail-1', provider: 'gmail',
        from: { address: 'hr@example.com' }, to: ['candidate@gmail.com'],
        subject: 'Interview invitation', receivedAt: '2026-09-03T00:00:00.000Z',
      },
      classification: { category: 'interview_invite', classificationConfidence: .9, reasons: [] },
      extracted: { companyName: '示例公司' }, recordId: 'record-1',
      confidences: { classificationConfidence: .9, matchConfidence: .8, decisionConfidence: .8 },
      reasons: [],
    }]}
    initialRecords={[{
      id: 'record-1', companyName: '示例公司', jobTitle: '工程师', sourceSite: '', sourceUrl: '',
      status: '已投递', notes: '', appliedAt: '', location: '', events: [], createdAt: '', updatedAt: '',
    }]}
  />);

  assert.match(html, /招聘邮件监控/);
  assert.match(html, /Gmail/);
  assert.match(html, /Outlook/);
  assert.match(html, /QQ \/ 163 \/ IMAP/);
  assert.match(html, /确认关联/);
  assert.match(html, /匹配置信度 80%/);
});
