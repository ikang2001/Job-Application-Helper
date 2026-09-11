import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApplicationDetail } from './ApplicationDetail.tsx';

test('投递详情展示快照和按来源标记的完整时间线', () => {
  const html = renderToStaticMarkup(<ApplicationDetail
    record={{
      id: 'record-1', companyName: '示例公司', jobTitle: '后端工程师', jobId: 'REQ-1',
      applicationId: 'APP-1', sourceSite: 'jobs.example.com', sourceUrl: 'https://jobs.example.com/1',
      status: '面试中', notes: '', appliedAt: '2026-09-01', applicationEmail: 'candidate@example.com',
      recruitmentSchedule: {
        writtenTest: { scheduledAt: '2026-09-04T19:00', url: 'https://exam.example.com/written' },
        assessment: { scheduledAt: '2026-09-05T14:30', url: 'https://exam.example.com/assessment' },
        interviews: {
          ai: { scheduledAt: '2026-09-06T10:00', url: 'https://meeting.example.com/ai' },
          first: { scheduledAt: '2026-09-07T10:00', url: 'https://meeting.example.com/first' },
          hr: { scheduledAt: '2026-09-08T10:00', url: 'https://meeting.example.com/hr' },
        },
      },
      resumeSnapshot: { profileName: '后端简历', fileName: 'resume.pdf' },
      jdSnapshot: { text: '负责服务端开发', capturedAt: '2026-09-01T00:00:00.000Z', sourceUrl: 'https://jobs.example.com/1', contentHash: 'hash', truncated: false },
      location: '上海', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z',
      events: [{
        id: 'event-1', type: 'interview_invite', occurredAt: '2026-09-03T08:00:00.000Z',
        timePrecision: 'datetime', source: 'email', title: '收到面试邀请',
        sourceKey: 'email:gmail:a:m:interview_invite', decisionConfidence: .98,
      }],
    }}
    onClose={() => undefined}
    onChanged={() => undefined}
  />);

  assert.match(html, /Job ID/);
  assert.match(html, /后端简历/);
  assert.match(html, /负责服务端开发/);
  assert.match(html, /收到面试邀请/);
  assert.match(html, /置信度 98%/);
  assert.match(html, /招聘邮件/);
  assert.match(html, /打开笔试链接/);
  assert.match(html, /打开测评链接/);
  assert.match(html, /打开AI面链接/);
  assert.match(html, /打开一面链接/);
  assert.match(html, /打开HR面链接/);
  assert.match(html, /2026\/9\/6 10:00:00/);
});
