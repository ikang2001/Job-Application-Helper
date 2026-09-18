import assert from 'node:assert/strict';
import test from 'node:test';
import { extractApplicationPageMetadata } from './applicationRecordMetadata.ts';

test('页面元数据提取返回 sourceSite/sourceUrl，并尽量提取公司名', async () => {
  const doc = {
    title: '星河软件校园招聘',
    body: { innerText: '', textContent: '' },
    querySelector: (selector: string) => {
      if (selector === 'meta[property="og:site_name"]') {
        return {
          getAttribute: (attribute: string) => (attribute === 'content' ? '星河软件招聘' : null),
        };
      }
      return null;
    },
    querySelectorAll: () => [],
  } as unknown as Document;

  const result = await extractApplicationPageMetadata(doc, 'https://jobs.example.com/campus');

  assert.equal(result.sourceSite, 'jobs.example.com');
  assert.equal(result.sourceUrl, 'https://jobs.example.com/campus');
  assert.match(result.companyName, /星河/);
  assert.equal(result.pageTitle, '星河软件校园招聘');
  assert.equal(result.extractionProvenance?.companyName?.source, 'meta');
});
