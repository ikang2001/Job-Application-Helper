import { FieldType, type UserProfile } from '../../shared/types.ts';
import {
  areEquivalentOptionValues,
  findBestMatchingOptionIndex,
} from '../../utils/optionMatcher.ts';
import { isUnsupportedProfileFieldLabel } from '../../utils/fieldMatcher.ts';
import { resolveEducationCountryRegion, resolvePersonalNationality } from '../../utils/profileSemantics.ts';
import { normalizeDescriptionText } from '../../utils/descriptionText.ts';
import type { AIFillSectionPayload } from './prompts.ts';

export interface SectionFillMapping {
  index: number;
  semanticType: string;
  value: string;
}

export const SECTION_FILL_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    mappings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          semanticType: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['index', 'semanticType', 'value'],
        additionalProperties: false,
      },
    },
  },
  required: ['mappings'],
  additionalProperties: false,
} as const;

const FILLABLE_FIELD_TYPES = new Set<string>(
  Object.values(FieldType).filter(type => (
    type !== FieldType.UNKNOWN && type !== FieldType.RESUME_FILE
  )),
);

export function parseSectionFillResponse(
  raw: string,
  payload: AIFillSectionPayload,
): SectionFillMapping[] {
  const parsed = parseJsonObject(raw);
  if (Array.isArray(parsed.mappings)) {
    return parsed.mappings
      .map(toSectionFillMapping)
      .filter((mapping): mapping is SectionFillMapping => mapping !== null);
  }

  // 兼容升级前的 {"字段index":"值"} 输出。未知语义没有可校验的字段
  // 类型，因此会在校验阶段被安全丢弃。
  const fields = new Map(payload.fields.map(field => [field.index, field]));
  return Object.entries(parsed)
    .map(([rawIndex, rawValue]) => {
      const index = Number(rawIndex);
      const field = fields.get(index);
      if (!Number.isInteger(index) || typeof rawValue !== 'string' || !field) return null;
      return {
        index,
        semanticType: field.semanticType || FieldType.UNKNOWN,
        value: rawValue.trim(),
      };
    })
    .filter((mapping): mapping is SectionFillMapping => mapping !== null);
}

export function validateSectionFillMappings(
  candidates: SectionFillMapping[],
  payload: AIFillSectionPayload,
  profile: UserProfile,
): Record<string, string> {
  const fields = new Map(payload.fields.map(field => [field.index, field]));
  const mappings: Record<string, string> = {};

  for (const candidate of candidates) {
    const field = fields.get(candidate.index);
    const value = candidate.value.trim();
    if (!field || !value || Object.hasOwn(mappings, candidate.index)) continue;
    if (isUnsupportedProfileFieldLabel(`${field.name} ${field.label} ${field.context}`)) continue;

    const detectedType = field.semanticType || FieldType.UNKNOWN;
    const proposedType = candidate.semanticType.trim();
    const semanticType = detectedType !== FieldType.UNKNOWN ? detectedType : proposedType;
    if (!FILLABLE_FIELD_TYPES.has(semanticType)) continue;
    if (detectedType !== FieldType.UNKNOWN && proposedType !== detectedType) continue;
    const resolvedValue = resolveWebsiteOption(value, field.options);
    if (!resolvedValue) continue;
    if (!matchesKnownProfileValue({ ...field, semanticType }, resolvedValue, profile)) continue;

    mappings[String(candidate.index)] = resolvedValue;
  }

  return mappings;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const withoutFence = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  const normalized = start >= 0 && end > start
    ? withoutFence.slice(start, end + 1)
    : withoutFence;

  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 使用统一业务错误，避免把 JSON.parse 的英文错误直接展示给用户。
  }
  throw new Error('AI 返回的字段映射不是合法 JSON');
}

function toSectionFillMapping(value: unknown): SectionFillMapping | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const index = typeof candidate.index === 'number'
    ? candidate.index
    : Number(candidate.index);
  if (
    !Number.isInteger(index)
    || typeof candidate.semanticType !== 'string'
    || typeof candidate.value !== 'string'
  ) {
    return null;
  }
  return {
    index,
    semanticType: candidate.semanticType.trim(),
    value: candidate.value.trim(),
  };
}

function matchesKnownProfileValue(
  field: AIFillSectionPayload['fields'][number],
  value: string,
  profile: UserProfile,
): boolean {
  const semanticType = field.semanticType || FieldType.UNKNOWN;
  if (semanticType === FieldType.UNKNOWN) return false;

  const rowIndex = field.rowIndex || 0;
  const personal = profile.personal;
  const education = profile.education[rowIndex];
  const experience = profile.experience[rowIndex];
  const project = profile.projects[rowIndex];
  const award = profile.awards[rowIndex];
  const language = profile.languages?.[rowIndex];
  const expected: Record<string, string | undefined> = {
    name: personal.name,
    gender: personal.gender,
    birthDate: personal.birthDate,
    phoneCountryCode: personal.phoneCountryCode || (personal.phone ? '+86' : ''),
    phone: personal.phone?.replace(/[\s()-]/g, '').replace(/^(?:\+86|0086)(?=1[3-9]\d{9}$)/, ''),
    email: personal.email,
    wechat: personal.wechat,
    idType: personal.idType || (personal.idCard ? '身份证' : ''),
    idCard: personal.idCard,
    nationality: resolvePersonalNationality(personal),
    politicalStatus: personal.politicalStatus,
    ethnicity: personal.ethnicity,
    hometown: personal.hometown,
    currentAddress: personal.currentAddress,
    selfEvaluation: personal.selfEvaluation,
    school: education?.school,
    educationCountry: resolveEducationCountryRegion(education),
    schoolLocation: education?.schoolLocation,
    college: education?.college,
    educationType: education?.educationType || (education ? '统招全日制' : ''),
    major: education?.major,
    degree: education?.degree,
    gpa: education?.gpa,
    educationStartDate: education?.startDate,
    graduationDate: education?.endDate,
    company: experience?.company,
    position: experience?.position,
    startDate: experience?.startDate,
    endDate: experience?.endDate,
    description: experience?.description ? normalizeDescriptionText(experience.description) : '',
    projectName: project?.name,
    projectRole: project?.role,
    projectStartDate: project?.startDate,
    projectEndDate: project?.endDate,
    projectDescription: project?.description ? normalizeDescriptionText(project.description) : '',
    awardName: award?.name,
    awardRole: award?.role,
    awardDate: award?.date,
    awardDescription: award?.description ? normalizeDescriptionText(award.description) : '',
    language: language?.language,
    languageCertificate: language?.certificate,
    languageLevel: language?.level,
    skills: profile.skills.join(', '),
  };
  const expectedValue = expected[semanticType]?.trim();
  if (!expectedValue) return false;

  return areEquivalentProfileValues(value, expectedValue, semanticType);
}

function areEquivalentProfileValues(actual: string, expected: string, semanticType: string): boolean {
  const normalize = (input: string) => input.toLowerCase().replace(/[\s（）()·,，./_-]/g, '');
  const actualValue = normalize(actual);
  const expectedValue = normalize(expected);
  if (actualValue === expectedValue) return true;

  if (/date$/i.test(semanticType)) {
    return normalizeDate(actual) === normalizeDate(expected);
  }

  const optionLikeTypes = new Set<string>([
    FieldType.GENDER,
    FieldType.PHONE_COUNTRY_CODE,
    FieldType.ID_TYPE,
    FieldType.EDUCATION_COUNTRY,
    FieldType.EDUCATION_TYPE,
    FieldType.DEGREE,
    FieldType.NATIONALITY,
    FieldType.POLITICAL_STATUS,
    FieldType.LANGUAGE,
    FieldType.LANGUAGE_CERTIFICATE,
    FieldType.LANGUAGE_LEVEL,
  ]);
  return optionLikeTypes.has(semanticType)
    && areEquivalentOptionValues(actual, expected);
}

function resolveWebsiteOption(value: string, options: string[]): string | null {
  if (options.length === 0) return value;
  const optionIndex = findBestMatchingOptionIndex(value, options);
  return optionIndex >= 0 ? options[optionIndex] : null;
}

function normalizeDate(value: string): string {
  const match = value.match(/(\d{4})\D{0,3}(\d{1,2})?/);
  return match ? `${match[1]}-${(match[2] || '01').padStart(2, '0')}` : '';
}
