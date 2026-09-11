import type {
  ExtractedJobField,
  JobPageContext,
  JobPageExtraction,
  JobPageExtractor,
  JobMetadataSource,
} from './types.ts';
import { normalizeJobDescription } from './snapshot.ts';
import { isGenericJobTitleLabel } from '../../shared/jobMetadata.ts';

type JsonObject = Record<string, unknown>;

const COMPANY_DOM_SELECTORS = [
  '[itemprop="hiringOrganization"] [itemprop="name"]',
  '[itemprop="hiringOrganization"]',
  '[data-company-name]',
  '.company-name',
  '[class*="company-name"]',
  '[class*="companyName"]',
];

const JOB_TITLE_DOM_SELECTORS = [
  '[itemprop="title"]',
  '[data-job-title]',
  '.job-title',
  '[class*="job-title"]',
  '[class*="jobTitle"]',
  '[class*="position-title"]',
  'main h1',
  'h1',
];

const DYNAMIC_JOB_NAME_DOM_SELECTORS = [
  '[class*="JobName"]',
  '[class*="jobName"]',
];

const LOCATION_DOM_SELECTORS = [
  '[itemprop="jobLocation"]',
  '[data-job-location]',
  '.job-location',
  '[class*="job-location"]',
  '[class*="jobLocation"]',
  '[class*="position-location"]',
];

const JOB_DESCRIPTION_DOM_SELECTORS = [
  '[itemprop="description"]',
  '[data-job-description]',
  '.job-description',
  '[class*="job-description"]',
  '[class*="jobDescription"]',
  '[class*="position-description"]',
  '.job-detail',
  '[class*="job-detail"]',
];

const JOB_ID_QUERY_KEYS = new Set([
  'gh_jid',
  'jid',
  'job_id',
  'jobid',
  'position_id',
  'positionid',
  'req_id',
  'reqid',
  'requisition_id',
  'requisitionid',
  'jobadid',
]);

export class GenericJobPageExtractor implements JobPageExtractor {
  match(_context: JobPageContext): boolean {
    return true;
  }

  extract(context: JobPageContext): JobPageExtraction {
    const jsonLd = pickJobPosting(readJsonLdNodes(context.document));
    const extractedCompanyName = firstField(
      jsonLdCompany(jsonLd),
      metaField(context.document, [
        'meta[property="og:site_name"]',
        'meta[name="application-name"]',
        'meta[name="author"]',
      ], 'companyName'),
      domField(context.document, COMPANY_DOM_SELECTORS, 'companyName'),
      titleCompany(context.document.title),
      bareTitleCompany(context.document.title),
    );
    const jobTitle = firstField(
      jsonLdTextField(jsonLd?.title, 0.99),
      domField(context.document, JOB_TITLE_DOM_SELECTORS, 'jobTitle'),
      dynamicJobNameField(context.document),
      labeledJobDetailTitle(context.document),
      labeledJobTitle(context.document),
      metaField(context.document, [
        'meta[property="og:title"]',
        'meta[name="twitter:title"]',
      ], 'jobTitle'),
      titleJob(context.document.title),
    );

    return compactExtraction({
      companyName: extractedCompanyName ?? pageTitleCompany(context.document.title, jobTitle),
      jobTitle: distinctJobTitle(jobTitle, extractedCompanyName),
      jobId: firstField(
        jsonLdIdentifier(jsonLd?.identifier),
        urlJobId(context.url),
        domJobId(context.document),
      ),
      location: firstField(
        jsonLdLocation(jsonLd),
        domField(context.document, LOCATION_DOM_SELECTORS, 'location'),
        labeledJobLocation(context.document),
        labeledBodyField(context.document, /(?:工作地点|职位地点|岗位地点|location)\s*[:：]?\s*([^\n|]{2,80})/i),
      ),
      employmentType: jsonLdEmploymentType(jsonLd?.employmentType),
      jobDescription: firstField(
        jsonLdDescription(jsonLd?.description),
        domField(context.document, JOB_DESCRIPTION_DOM_SELECTORS, 'jobDescription'),
        labeledDescription(context.document),
      ),
    });
  }
}

export const genericJobPageExtractor = new GenericJobPageExtractor();

function readJsonLdNodes(doc: Document): JsonObject[] {
  if (typeof doc.querySelectorAll !== 'function') {
    return [];
  }

  const nodes: JsonObject[] = [];
  const scripts = Array.from(
    doc.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'),
  );
  for (const script of scripts) {
    const raw = script.textContent?.trim();
    if (!raw) continue;

    try {
      collectJsonObjects(JSON.parse(raw) as unknown, nodes, 0);
    } catch {
      // Invalid third-party JSON-LD must not block the generic DOM fallbacks.
    }
  }
  return nodes;
}

function collectJsonObjects(value: unknown, result: JsonObject[], depth: number): void {
  if (depth > 12) return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonObjects(item, result, depth + 1);
    return;
  }
  if (!isJsonObject(value)) return;

  result.push(value);
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested) || isJsonObject(nested)) {
      collectJsonObjects(nested, result, depth + 1);
    }
  }
}

function pickJobPosting(nodes: JsonObject[]): JsonObject | undefined {
  return nodes
    .filter(node => hasSchemaType(node, 'JobPosting'))
    .sort((left, right) => jobPostingCompleteness(right) - jobPostingCompleteness(left))[0];
}

function hasSchemaType(node: JsonObject, expected: string): boolean {
  const type = node['@type'];
  return (Array.isArray(type) ? type : [type]).some(value => (
    typeof value === 'string'
      && value.split(/[/#]/).at(-1)?.toLowerCase() === expected.toLowerCase()
  ));
}

function jobPostingCompleteness(node: JsonObject): number {
  return ['title', 'hiringOrganization', 'identifier', 'jobLocation', 'description']
    .filter(key => node[key] !== undefined)
    .length;
}

function jsonLdCompany(jobPosting: JsonObject | undefined): ExtractedJobField | undefined {
  const organization = asArray(jobPosting?.hiringOrganization)[0];
  const value = typeof organization === 'string'
    ? organization
    : isJsonObject(organization)
      ? readString(organization.name) || readString(organization.legalName)
      : '';
  return makeField(normalizeCompanyName(value), 'json-ld', 0.98);
}

function jsonLdIdentifier(identifier: unknown): ExtractedJobField | undefined {
  if (Array.isArray(identifier)) {
    return identifier.map(jsonLdIdentifier).find(Boolean);
  }
  if (typeof identifier === 'string' || typeof identifier === 'number') {
    return makeField(String(identifier), 'json-ld', 0.99);
  }
  if (!isJsonObject(identifier)) return undefined;

  return makeField(
    readString(identifier.value) || readString(identifier.name) || readString(identifier['@id']),
    'json-ld',
    0.99,
  );
}

function jsonLdLocation(jobPosting: JsonObject | undefined): ExtractedJobField | undefined {
  const locations = asArray(jobPosting?.jobLocation)
    .map(formatLocation)
    .filter(Boolean);
  if (locations.length > 0) {
    return makeField([...new Set(locations)].join(' / '), 'json-ld', 0.97);
  }

  const locationType = readString(jobPosting?.jobLocationType);
  if (/telecommute|remote/i.test(locationType)) {
    return makeField('Remote', 'json-ld', 0.9);
  }
  return undefined;
}

function formatLocation(value: unknown): string {
  if (typeof value === 'string') return normalizeText(value);
  if (!isJsonObject(value)) return '';

  const address = value.address ?? (hasPostalAddressFields(value) ? value : undefined);
  if (typeof address === 'string') return normalizeText(address);
  if (!isJsonObject(address)) return normalizeText(readString(value.name));

  const country = isJsonObject(address.addressCountry)
    ? readString(address.addressCountry.name)
    : readString(address.addressCountry);
  const parts = [
    readString(address.addressLocality),
    readString(address.addressRegion),
    country,
  ].map(normalizeText).filter(Boolean);
  return [...new Set(parts)].join(', ') || normalizeText(readString(value.name));
}

function jsonLdEmploymentType(value: unknown): ExtractedJobField | undefined {
  const values = asArray(value).map(readString).map(normalizeText).filter(Boolean);
  return makeField([...new Set(values)].join(', '), 'json-ld', 0.96);
}

function jsonLdDescription(value: unknown): ExtractedJobField | undefined {
  return makeField(normalizeJobDescription(readString(value)), 'json-ld', 0.98);
}

function jsonLdTextField(value: unknown, confidence: number): ExtractedJobField | undefined {
  const title = normalizeJobTitle(readString(value));
  return title ? makeField(title, 'json-ld', confidence) : undefined;
}

function metaField(
  doc: Document,
  selectors: string[],
  field: 'companyName' | 'jobTitle',
): ExtractedJobField | undefined {
  for (const selector of selectors) {
    const content = doc.querySelector(selector)?.getAttribute('content') ?? '';
    const normalized = field === 'companyName'
      ? normalizeCompanyName(content)
      : normalizeJobTitle(content);
    if (normalized) return makeField(normalized, 'meta', field === 'companyName' ? 0.88 : 0.72);
  }
  return undefined;
}

function domField(
  doc: Document,
  selectors: string[],
  field: JobMetadataFieldName,
): ExtractedJobField | undefined {
  for (const selector of selectors) {
    const element = doc.querySelector(selector);
    if (!element) continue;

    const raw = readableElementText(element);
    const normalized = field === 'companyName'
      ? normalizeCompanyName(raw)
      : field === 'jobTitle'
        ? normalizeJobTitle(raw)
        : field === 'jobDescription'
          ? normalizeJobDescription(raw)
          : normalizeText(raw);
    if (normalized) return makeField(normalized, 'dom', field === 'jobDescription' ? 0.86 : 0.82);
  }
  return undefined;
}

function dynamicJobNameField(doc: Document): ExtractedJobField | undefined {
  for (const selector of DYNAMIC_JOB_NAME_DOM_SELECTORS) {
    const candidates = Array.from(doc.querySelectorAll(selector))
      .map(element => normalizeJobTitle(readableElementText(element)))
      .filter(isConciseJobTitle)
      .sort((left, right) => left.length - right.length);
    if (candidates[0]) return makeField(candidates[0], 'dom', 0.84);
  }
  return undefined;
}

function isConciseJobTitle(value: string): boolean {
  return value.length > 0
    && value.length <= 120
    && !/(?:职位描述|岗位描述|岗位职责|工作职责|任职要求|职位详情)/.test(value);
}

function labeledJobDetailTitle(doc: Document): ExtractedJobField | undefined {
  const title = normalizeJobTitle(findSemanticLabeledValue(
    doc,
    ['职位名称', '岗位名称', 'job title'],
    [
      '薪资范围', '职位性质', '岗位性质', '职能类型', '职位类别', '所属部门',
      '工作地点', '职位地点', '岗位地点', '发布日期', '职位描述', '岗位描述',
    ],
    160,
  ));
  return isConciseJobTitle(title) ? makeField(title, 'dom', 0.82) : undefined;
}

function labeledJobLocation(doc: Document): ExtractedJobField | undefined {
  const location = findSemanticLabeledValue(
    doc,
    ['工作地点', '职位地点', '岗位地点', 'location'],
    ['发布日期', '发布时间', '职位描述', '岗位描述', '任职资格', '申请职位'],
    80,
  );
  return makeField(location, 'dom', 0.82);
}

function findSemanticLabeledValue(
  doc: Document,
  labels: readonly string[],
  terminators: readonly string[],
  maxLength: number,
): string {
  const bodyText = doc.body?.innerText || doc.body?.textContent || '';
  const lines = bodyText.split(/[\r\n]+/).map(normalizeText).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const inline = stripLeadingLabel(lines[index], labels);
    if (inline && !isSemanticLabel(inline, labels) && !isSemanticLabel(inline, terminators)) {
      return inline.slice(0, maxLength);
    }
    if (!isSemanticLabel(lines[index], labels)) continue;

    let valueIndex = index + 1;
    while (valueIndex < lines.length && isSemanticLabel(lines[valueIndex], labels)) valueIndex += 1;
    const candidate = lines[valueIndex] ?? '';
    if (candidate && !isSemanticLabel(candidate, terminators)) return candidate.slice(0, maxLength);
  }

  const labelPattern = labels.map(escapeRegExp).join('|');
  const terminatorPattern = terminators.map(escapeRegExp).join('|');
  const normalizedBody = normalizeText(bodyText);
  const matched = normalizedBody.match(new RegExp(
    `(?:^|\\s)(?:${labelPattern})\\s*[:：]?\\s*(?:(?:${labelPattern})\\s*[:：]?\\s*)?(.{2,${maxLength}}?)(?=\\s+(?:${terminatorPattern})(?:\\s|[:：]|$)|$)`,
    'i',
  ));
  return normalizeText(matched?.[1] ?? '');
}

function stripLeadingLabel(value: string, labels: readonly string[]): string {
  const pattern = labels.map(escapeRegExp).join('|');
  const matched = value.match(new RegExp(
    `^(?:${pattern})(?:\\s*[:：]\\s*|\\s+)(.+)$`,
    'i',
  ));
  return normalizeText(matched?.[1] ?? '');
}

function isSemanticLabel(value: string, labels: readonly string[]): boolean {
  const normalized = normalizeText(value).replace(/[:：]$/, '').toLocaleLowerCase();
  return labels.some(label => normalized === label.toLocaleLowerCase());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function labeledJobTitle(doc: Document): ExtractedJobField | undefined {
  const bodyText = doc.body?.innerText || doc.body?.textContent || '';
  const matched = bodyText.match(
    /(?:你正在\s*)?(?:投递|申请)(?:的)?\s*(?:职位|岗位)\s*[:：]?\s*([^\n|]{2,160}?)(?=\s*(?:最多可投递|还可投递|申请状态|投递状态|$))/i,
  );
  const title = normalizeJobTitle(matched?.[1] ?? '');
  return isConciseJobTitle(title) ? makeField(title, 'dom', 0.8) : undefined;
}

type JobMetadataFieldName = 'companyName' | 'jobTitle' | 'location' | 'jobDescription';

function readableElementText(element: Element): string {
  if (typeof element.cloneNode !== 'function') {
    return element.textContent ?? '';
  }

  const clone = element.cloneNode(true) as Element;
  if (typeof clone.querySelectorAll === 'function') {
    clone.querySelectorAll('script, style, noscript, template').forEach(node => node.remove());
  }
  return clone.textContent ?? '';
}

function titleCompany(title: string): ExtractedJobField | undefined {
  const matched = normalizeText(title).match(
    /([\u4e00-\u9fa5A-Za-z0-9（）()·\-.&\s]+?)(?:校园招聘|社会招聘|招聘|校招|职位)/,
  );
  const segments = (matched?.[1] ?? '').split(/\s*[|｜—–_-]\s*/).filter(Boolean);
  return makeField(normalizeCompanyName(segments.at(-1) ?? ''), 'title', 0.58);
}

function bareTitleCompany(title: string): ExtractedJobField | undefined {
  const normalizedTitle = normalizeCompanyName(title);
  if (!looksLikeCompanyName(normalizedTitle)) return undefined;
  return makeField(normalizedTitle, 'title', 0.62);
}

function pageTitleCompany(
  title: string,
  jobTitle: ExtractedJobField | undefined,
): ExtractedJobField | undefined {
  const normalized = normalizeCompanyName(title);
  if (!jobTitle || !normalized || normalized.length > 80) return undefined;
  if (normalizeText(normalized).toLowerCase() === normalizeText(jobTitle.value).toLowerCase()) return undefined;
  if (isGenericJobTitleLabel(normalized) || /^(?:首页|官网|详情|申请表|投递申请|简历投递)$/i.test(normalized)) {
    return undefined;
  }
  return makeField(normalized, 'title', 0.54);
}

function titleJob(title: string): ExtractedJobField | undefined {
  const normalizedTitle = normalizeText(title);
  const hasSeparator = /[|｜—–_-]/.test(normalizedTitle);
  if (!hasSeparator && (
    /(?:校园招聘|社会招聘|招聘官网|校招|careers?)$/i.test(normalizedTitle)
    || looksLikeCompanyName(normalizedTitle)
  )) {
    return undefined;
  }
  const parts = normalizeText(title)
    .split(/\s+(?:[-|–—·]|at|@)\s+|\s*[_|｜]\s*/i)
    .map(normalizeJobTitle)
    .filter(Boolean);
  return makeField(parts[0] ?? '', 'title', 0.58);
}

function looksLikeCompanyName(value: string): boolean {
  return /(?:股份有限公司|有限责任公司|有限公司|集团(?:有限公司)?|公司|company|co\.?\s*,?\s*ltd\.?|ltd\.?|inc\.?|corp(?:oration)?\.?)$/i
    .test(normalizeText(value));
}

function urlJobId(url: string): ExtractedJobField | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  for (const [key, value] of parsed.searchParams) {
    if (JOB_ID_QUERY_KEYS.has(key.toLowerCase()) && normalizeJobId(value)) {
      return makeField(normalizeJobId(value), 'url', 0.92);
    }
  }

  const pathPatterns = [
    /\/(?:jobs?|positions?|requisitions?|jobdetails?|job-detail)\/([^/?#]+)/i,
    /\/(?:jobs?|positions?)[-_]([A-Za-z0-9][A-Za-z0-9._-]*)/i,
  ];
  const pathAndHash = `${parsed.pathname}/${parsed.hash.replace(/^#?!?\/?/, '')}`;
  for (const pattern of pathPatterns) {
    const matched = pathAndHash.match(pattern);
    const jobId = normalizeJobId(matched?.[1] ?? '');
    if (jobId && !isGenericPathToken(jobId)) return makeField(jobId, 'url', 0.86);
  }
  return undefined;
}

function domJobId(doc: Document): ExtractedJobField | undefined {
  const explicit = doc.querySelector(
    '[data-job-id], [data-requisition-id], [class*="job-id"], [class*="requisition-id"]',
  );
  const explicitId = explicit?.getAttribute('data-job-id')
    || explicit?.getAttribute('data-requisition-id')
    || parseLabeledJobId(explicit?.textContent ?? '');
  if (normalizeJobId(explicitId ?? '')) {
    return makeField(normalizeJobId(explicitId ?? ''), 'dom', 0.8);
  }

  const bodyText = doc.body?.innerText || doc.body?.textContent || '';
  return makeField(parseLabeledJobId(bodyText), 'dom', 0.7);
}

function parseLabeledJobId(value: string): string {
  const matched = value.match(
    /(?:job\s*id|job\s*code|req(?:uisition)?\s*id|position\s*id|职位编号|岗位编号|招聘编号)\s*[:：#]?\s*([A-Za-z0-9][A-Za-z0-9._/-]{1,80})/i,
  );
  return normalizeJobId(matched?.[1] ?? '');
}

function labeledBodyField(doc: Document, pattern: RegExp): ExtractedJobField | undefined {
  const bodyText = doc.body?.innerText || doc.body?.textContent || '';
  const matched = bodyText.match(pattern);
  return makeField(normalizeText(matched?.[1] ?? ''), 'dom', 0.68);
}

function labeledDescription(doc: Document): ExtractedJobField | undefined {
  if (typeof doc.querySelectorAll !== 'function') return undefined;

  const headings = Array.from(doc.querySelectorAll<HTMLElement>('h1, h2, h3, h4, [role="heading"]'));
  const heading = headings.find(element => (
    /^(?:职位描述|岗位描述|工作职责|职位职责|job description|responsibilities)$/i
      .test(normalizeText(element.textContent ?? ''))
  ));
  if (!heading) return undefined;

  const container = heading.parentElement ?? heading.nextElementSibling ?? heading;
  return makeField(normalizeJobDescription(readableElementText(container)), 'dom', 0.72);
}

function normalizeCompanyName(value: string): string {
  return normalizeText(value)
    .replace(/招聘官网|校园招聘|社会招聘|招聘|校招|职位官网/g, '')
    .replace(/^[\s|｜—–_-]+|[\s|｜—–_-]+$/g, '')
    .trim();
}

function normalizeJobTitle(value: string): string {
  const normalized = normalizeText(value)
    .replace(/^(?:职位名称|岗位名称|job title)\s*[:：]?\s*/i, '')
    .trim();
  return isGenericJobTitleLabel(normalized) ? '' : normalized;
}

function distinctJobTitle(
  jobTitle: ExtractedJobField | undefined,
  companyName: ExtractedJobField | undefined,
): ExtractedJobField | undefined {
  if (!jobTitle || !companyName) return jobTitle;
  return normalizeText(jobTitle.value).toLowerCase() === normalizeText(companyName.value).toLowerCase()
    ? undefined
    : jobTitle;
}

function normalizeJobId(value: string): string {
  let decoded = value.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the original path/query token when percent-encoding is malformed.
  }
  return decoded.replace(/^[#\s]+|[\s,;。；]+$/g, '').slice(0, 128);
}

function isGenericPathToken(value: string): boolean {
  return /^(?:apply|career|careers|detail|details|list|openings?|search)$/i.test(value);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function makeField(
  value: string,
  source: JobMetadataSource,
  confidence: number,
): ExtractedJobField | undefined {
  const normalized = normalizeText(value);
  return normalized ? { value: normalized, source, confidence } : undefined;
}

function firstField(...fields: Array<ExtractedJobField | undefined>): ExtractedJobField | undefined {
  return fields.find(Boolean);
}

function compactExtraction(extraction: JobPageExtraction): JobPageExtraction {
  return Object.fromEntries(
    Object.entries(extraction).filter(([, value]) => value !== undefined),
  ) as JobPageExtraction;
}

function readString(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return '';
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasPostalAddressFields(value: JsonObject): boolean {
  return ['addressLocality', 'addressRegion', 'addressCountry'].some(key => value[key] !== undefined);
}
