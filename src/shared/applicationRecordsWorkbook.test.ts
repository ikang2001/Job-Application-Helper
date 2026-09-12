import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import {
  buildApplicationRecordsWorkbook,
  buildApplicationRecordsWorkbookFilename,
} from './applicationRecordsWorkbook.ts';
import type { ApplicationRecord } from './types.ts';

function record(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    id: 'record-1',
    companyName: '示例公司',
    jobTitle: '后端工程师',
    sourceSite: 'jobs.example.com',
    sourceUrl: 'https://jobs.example.com/apply?id=1&from=xlsx',
    status: '已投递',
    notes: '不应出现在 Excel 中',
    appliedAt: '2026-09-12',
    location: '深圳',
    events: [],
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
    ...overrides,
  };
}

test('Excel 导出包含 6 列表格和可点击的原生超链接', async () => {
  const blob = await buildApplicationRecordsWorkbook([record()], new Date('2026-09-12T08:00:00.000Z'));
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  const relationships = await zip.file('xl/worksheets/_rels/sheet1.xml.rels')!.async('string');

  assert.match(sheet, /<t xml:space="preserve">公司<\/t>/);
  assert.match(sheet, /<t xml:space="preserve">工作地点<\/t>/);
  assert.match(sheet, /<hyperlink ref="C2" r:id="rId1"\/>/);
  assert.match(sheet, /https:\/\/jobs\.example\.com\/apply\?id=1&amp;from=xlsx/);
  assert.doesNotMatch(sheet, /不应出现在 Excel 中|schemaVersion|sourceSite/);
  assert.match(relationships, /Target="https:\/\/jobs\.example\.com\/apply\?id=1&amp;from=xlsx" TargetMode="External"/);
  assert.equal(
    buildApplicationRecordsWorkbookFilename(new Date('2026-09-12T08:09:10.000Z')),
    'application-records-20260912-080910.xlsx',
  );
});

test('Excel 导出不把非 HTTP 内容写成超链接', async () => {
  const blob = await buildApplicationRecordsWorkbook([record({ sourceUrl: 'javascript:alert(1)' })]);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  const relationships = await zip.file('xl/worksheets/_rels/sheet1.xml.rels')!.async('string');

  assert.doesNotMatch(sheet, /<hyperlink /);
  assert.doesNotMatch(relationships, /relationships\/hyperlink/);
});
