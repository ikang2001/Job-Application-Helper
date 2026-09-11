import assert from 'node:assert/strict';
import test from 'node:test';
import { extractApplicationPageMetadata } from '../applicationRecordMetadata.ts';
import { GenericJobPageExtractor } from './generic.ts';

interface FakeElementOptions {
  text?: string;
  attributes?: Record<string, string>;
}

function fakeElement(options: FakeElementOptions = {}): Element {
  return {
    textContent: options.text ?? '',
    parentElement: null,
    nextElementSibling: null,
    getAttribute: (name: string) => options.attributes?.[name] ?? null,
    cloneNode() {
      return fakeElement(options);
    },
    querySelectorAll: () => [],
  } as unknown as Element;
}

function fakeDocument(input: {
  title?: string;
  referrer?: string;
  bodyText?: string;
  selectors?: Record<string, Element | Element[]>;
  jsonLd?: string[];
  headings?: Element[];
}): Document {
  const selectors = input.selectors ?? {};
  return {
    title: input.title ?? '',
    referrer: input.referrer ?? '',
    body: {
      innerText: input.bodyText ?? '',
      textContent: input.bodyText ?? '',
    },
    querySelector: (selector: string) => {
      const matched = selectors[selector];
      return Array.isArray(matched) ? matched[0] ?? null : matched ?? null;
    },
    querySelectorAll: (selector: string) => {
      if (selector === 'script[type="application/ld+json"]') {
        return (input.jsonLd ?? []).map(text => fakeElement({ text }));
      }
      if (selector === 'h1, h2, h3, h4, [role="heading"]') {
        return input.headings ?? [];
      }
      const matched = selectors[selector];
      return Array.isArray(matched) ? matched : matched ? [matched] : [];
    },
  } as unknown as Document;
}

test('Generic extractor reads JobPosting from a JSON-LD @graph before conflicting fallbacks', () => {
  const doc = fakeDocument({
    title: 'Fallback Engineer | Fallback Careers',
    selectors: {
      'meta[property="og:site_name"]': fakeElement({ attributes: { content: 'Fallback 招聘' } }),
      'main h1': fakeElement({ text: 'DOM Engineer' }),
      '.job-location': fakeElement({ text: '深圳' }),
    },
    jsonLd: [JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'Organization', name: 'Unrelated Organization' },
        {
          '@type': ['Thing', 'JobPosting'],
          title: 'Senior Platform Engineer',
          identifier: { '@type': 'PropertyValue', value: 'REQ-2026-42' },
          hiringOrganization: { '@type': 'Organization', name: 'Acme Labs' },
          jobLocation: [
            {
              '@type': 'Place',
              address: {
                addressLocality: '上海',
                addressRegion: '上海市',
                addressCountry: { name: '中国' },
              },
            },
          ],
          employmentType: ['FULL_TIME', 'CONTRACTOR'],
          description: '<p>Build&nbsp;reliable systems.</p><script>ignore()</script>',
        },
      ],
    })],
  });

  const result = new GenericJobPageExtractor().extract({
    document: doc,
    url: 'https://jobs.example.com/opening?jobId=fallback-id',
  });

  assert.deepEqual(result.companyName, {
    value: 'Acme Labs',
    source: 'json-ld',
    confidence: 0.98,
  });
  assert.equal(result.jobTitle?.value, 'Senior Platform Engineer');
  assert.equal(result.jobId?.value, 'REQ-2026-42');
  assert.equal(result.location?.value, '上海, 上海市, 中国');
  assert.equal(result.employmentType?.value, 'FULL_TIME, CONTRACTOR');
  assert.equal(result.jobDescription?.value, 'Build reliable systems.');
});

test('Generic extractor tolerates invalid JSON-LD and uses meta, DOM, URL and labeled text', () => {
  const doc = fakeDocument({
    title: '研发工程师 | 某科技招聘',
    bodyText: '职位编号：BODY-1\n工作地点：杭州市余杭区',
    jsonLd: ['{ invalid json'],
    selectors: {
      'meta[property="og:site_name"]': fakeElement({ attributes: { content: '某科技招聘' } }),
      'main h1': fakeElement({ text: '研发工程师' }),
      '[data-job-description]': fakeElement({ text: '负责 后端\n系统 的设计与开发' }),
    },
  });

  const result = new GenericJobPageExtractor().extract({
    document: doc,
    url: 'https://career.example.cn/jobs/detail?positionId=POS-7788&utm_source=test',
  });

  assert.equal(result.companyName?.value, '某科技');
  assert.equal(result.companyName?.source, 'meta');
  assert.equal(result.jobTitle?.value, '研发工程师');
  assert.equal(result.jobTitle?.source, 'dom');
  assert.equal(result.jobId?.value, 'POS-7788');
  assert.equal(result.jobId?.source, 'url');
  assert.equal(result.location?.value, '杭州市余杭区');
  assert.equal(result.jobDescription?.value, '负责 后端 系统 的设计与开发');
});

test('Generic extractor supports path Job IDs and leaves missing JD unset', () => {
  const doc = fakeDocument({
    title: 'Data Scientist - Example Careers',
    selectors: {
      'h1': fakeElement({ text: 'Data Scientist' }),
    },
  });

  const result = new GenericJobPageExtractor().extract({
    document: doc,
    url: 'https://example.com/jobs/JOB-9001',
  });

  assert.equal(result.jobTitle?.value, 'Data Scientist');
  assert.equal(result.jobId?.value, 'JOB-9001');
  assert.equal(result.jobDescription, undefined);
});

test('Generic extractor separates a bare company page title from a CSS-in-JS JobName and reads jobAdId', () => {
  const doc = fakeDocument({
    title: '思必驰科技股份有限公司',
    selectors: {
      '[class*="JobName"]': [
        fakeElement({
          text: `Agent开发工程师-2027届 ${'职位描述与任职要求 '.repeat(20)}`,
        }),
        fakeElement({ text: 'Agent开发工程师-2027届' }),
      ],
    },
  });

  const result = new GenericJobPageExtractor().extract({
    document: doc,
    url: 'https://campus.example.com/campus/detail?jobAdId=55edb0b1-0a32-435f-951c-4bb5bfae8db3',
  });

  assert.deepEqual(result.companyName, {
    value: '思必驰科技股份有限公司',
    source: 'title',
    confidence: 0.62,
  });
  assert.deepEqual(result.jobTitle, {
    value: 'Agent开发工程师-2027届',
    source: 'dom',
    confidence: 0.84,
  });
  assert.equal(result.jobId?.value, '55edb0b1-0a32-435f-951c-4bb5bfae8db3');
  assert.equal(result.jobId?.source, 'url');
});

test('Generic extractor never reuses a bare company page title as the job title', () => {
  const result = new GenericJobPageExtractor().extract({
    document: fakeDocument({ title: '示例科技有限责任公司' }),
    url: 'https://campus.example.com/campus/detail',
  });

  assert.equal(result.companyName?.value, '示例科技有限责任公司');
  assert.equal(result.jobTitle, undefined);
});

test('Generic extractor reads repeated semantic labels on a dynamic job detail page', () => {
  const result = new GenericJobPageExtractor().extract({
    document: fakeDocument({
      title: '示例智造 - 校园招聘',
      bodyText: [
        'AI智能体开发工程师-campus-2027',
        '全职 | 研发技术 | 平台事业部 | 北京市 发布于 2026-08-20',
        '职位描述',
        '负责智能体应用开发。',
        '职位信息',
        '职位名称',
        '职位名称',
        'AI智能体开发工程师-campus-2027',
        '薪资范围',
        '薪资范围',
        '-',
        '工作地点',
        '工作地点',
        '北京市',
        '发布日期',
        '2026-08-20',
      ].join('\n'),
    }),
    url: 'https://recruit.example.com/campus/168294#/job/4ef35732-eb5a-4929-9102-47397013ac56',
  });

  assert.equal(result.companyName?.value, '示例智造');
  assert.equal(result.jobTitle?.value, 'AI智能体开发工程师-campus-2027');
  assert.equal(result.jobTitle?.source, 'dom');
  assert.equal(result.location?.value, '北京市');
  assert.equal(result.location?.source, 'dom');
  assert.equal(result.jobId?.value, '4ef35732-eb5a-4929-9102-47397013ac56');
});

test('Generic extractor rejects application action headings and a company duplicate as job titles', () => {
  const doc = fakeDocument({
    title: '小黑盒',
    selectors: {
      '.company-name': fakeElement({ text: '小黑盒' }),
      'h1': fakeElement({ text: '投递岗位' }),
    },
  });

  const result = new GenericJobPageExtractor().extract({
    document: doc,
    url: 'https://jobs.example.com/application/submit',
  });

  assert.equal(result.companyName?.value, '小黑盒');
  assert.equal(result.jobTitle, undefined);
});

test('application form reads its labeled job title and keeps the referring job detail URL', async () => {
  const detailUrl = 'https://aspire.example.com/campus/detail?jobAdId=2921d413-bf24-4796-bee9-c75592724bfb';
  const doc = fakeDocument({
    title: '卓望公司',
    referrer: detailUrl,
    bodyText: '你正在 投递 职位 :  AI应用开发工程师-广州-27届校招（15k-25k）(J10788)\n最多可投递 3 个校园招聘职位',
  });

  const result = await extractApplicationPageMetadata(
    doc,
    'https://aspire.example.com/form?fromPage=job&jobAdId=2921d413-bf24-4796-bee9-c75592724bfb',
  );

  assert.equal(result.jobTitle, 'AI应用开发工程师-广州-27届校招（15k-25k）(J10788)');
  assert.equal(result.companyName, '卓望公司');
  assert.equal(result.jobId, '2921d413-bf24-4796-bee9-c75592724bfb');
  assert.equal(result.sourceUrl, detailUrl);
  assert.equal(result.sourceSite, 'aspire.example.com');
});

test('application form can use a distinct brand page title as the company name', async () => {
  const result = await extractApplicationPageMetadata(
    fakeDocument({
      title: '小黑盒',
      bodyText: '你正在投递职位：客户端开发工程师\n最多可投递 2 个职位',
    }),
    'https://jobs.example.com/form?jobId=42',
  );

  assert.equal(result.companyName, '小黑盒');
  assert.equal(result.jobTitle, '客户端开发工程师');
});

test('application metadata exposes snapshot and field provenance without hashing the truncated prefix', async () => {
  const fullDescription = `职责：${'构建可靠系统 '.repeat(3_000)}`.trim();
  const doc = fakeDocument({
    title: '平台工程师 | 示例公司',
    jsonLd: [JSON.stringify({
      '@type': 'JobPosting',
      title: '平台工程师',
      hiringOrganization: { name: '示例公司' },
      description: fullDescription,
    })],
  });
  let hashedText = '';

  const result = await extractApplicationPageMetadata(
    doc,
    'https://jobs.example.com/jobs/42',
    {
      capturedAt: '2026-09-03T10:00:00.000Z',
      digest: async (text) => {
        hashedText = text;
        return 'full-content-hash';
      },
    },
  );

  assert.equal(hashedText, fullDescription.replace(/\s+/g, ' '));
  assert.equal(result.jdSnapshot?.text.length, 16_000);
  assert.equal(result.jdSnapshot?.contentHash, 'full-content-hash');
  assert.equal(result.jdSnapshot?.truncated, true);
  assert.equal(result.jdSnapshot?.capturedAt, '2026-09-03T10:00:00.000Z');
  assert.equal(result.extractionProvenance?.jobDescription?.source, 'json-ld');
});
