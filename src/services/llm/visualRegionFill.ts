import {
  FieldType,
  type UserProfile,
  type VisualRegionControlCandidate,
  type VisualRegionFillMapping,
  type VisualRegionFillMappingResult,
  type VisualRegionFillPayload,
} from '../../shared/types.ts';
import {
  areEquivalentOptionValues,
  findBestMatchingOptionIndex,
} from '../../utils/optionMatcher.ts';
import { isUnsupportedProfileFieldLabel } from '../../utils/fieldMatcher.ts';
import { resolveEducationCountryRegion, resolvePersonalNationality } from '../../utils/profileSemantics.ts';
import { normalizeDescriptionText } from '../../utils/descriptionText.ts';

export function parseVisualRegionFillResponse(raw: string): VisualRegionFillMappingResult {
  const normalized = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new Error('视觉补填结果不是合法 JSON');
  }

  const mappings = Array.isArray((parsed as { mappings?: unknown })?.mappings)
    ? (parsed as { mappings: unknown[] }).mappings
        .filter(isVisualRegionFillMapping)
        .map(mapping => ({
          controlId: mapping.controlId.trim(),
          fieldMeaning: mapping.fieldMeaning.trim(),
          matchedProfilePath: mapping.matchedProfilePath.trim(),
          value: mapping.value.trim(),
        }))
    : [];

  return { mappings };
}

export function validateVisualRegionMappings(
  mappings: VisualRegionFillMappingResult['mappings'],
  payload: VisualRegionFillPayload,
  profile: UserProfile,
): VisualRegionFillMappingResult['mappings'] {
  const controls = new Map<string, VisualRegionControlCandidate>(
    payload.controls.map(control => [control.controlId, control]),
  );

  const validated: VisualRegionFillMapping[] = [];
  for (const mapping of mappings) {
    const control = controls.get(mapping.controlId);
    if (!control || !mapping.value.trim()) continue;
    if (isUnsupportedProfileFieldLabel(
      `${control.name} ${control.label} ${control.placeholder} ${control.contextText}`,
    )) continue;

    const profileValue = getProfileValue(profile, mapping.matchedProfilePath);
    if (typeof profileValue !== 'string') continue;

    const resolvedValue = resolveVisualValue(mapping, control, profileValue);
    if (!resolvedValue) continue;
    validated.push({ ...mapping, value: resolvedValue });
  }

  return validated;
}

const OPTION_LIKE_SEMANTIC_TYPES = new Set<string>([
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

const OPTION_LIKE_PROFILE_FIELDS = new Set([
  'gender',
  'phoneCountryCode',
  'idType',
  'countryRegion',
  'educationType',
  'degree',
  'nationality',
  'politicalStatus',
  'language',
  'certificate',
  'level',
]);

function resolveVisualValue(
  mapping: VisualRegionFillMapping,
  control: VisualRegionControlCandidate,
  profileValue: string,
): string | null {
  const profileField = mapping.matchedProfilePath.split('.').filter(Boolean).at(-1);
  const expectedProfileValue = profileField === 'description'
    ? normalizeDescriptionText(profileValue)
    : profileValue;
  const optionLike = isOptionLikeControl(control, mapping.matchedProfilePath);
  if (control.options.length === 0) {
    return mapping.value === expectedProfileValue ? mapping.value : null;
  }

  const exactIndex = control.options.indexOf(mapping.value);
  const optionIndex = exactIndex >= 0
    ? exactIndex
    : optionLike
      ? findBestMatchingOptionIndex(mapping.value, control.options)
      : -1;
  if (optionIndex < 0) return null;

  const resolvedValue = control.options[optionIndex];
  const matchesProfile = resolvedValue === expectedProfileValue
    || (optionLike && areEquivalentOptionValues(resolvedValue, expectedProfileValue));
  return matchesProfile ? resolvedValue : null;
}

function isOptionLikeControl(
  control: VisualRegionControlCandidate,
  profilePath: string,
): boolean {
  if (control.semanticType && OPTION_LIKE_SEMANTIC_TYPES.has(control.semanticType)) {
    return true;
  }
  const profileField = profilePath.split('.').filter(Boolean).at(-1);
  return Boolean(profileField && OPTION_LIKE_PROFILE_FIELDS.has(profileField));
}

function getProfileValue(profile: UserProfile, path: string): unknown {
  const value = path
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((current, segment) => {
      if (current === null || current === undefined) return undefined;
      const key = /^\d+$/.test(segment) ? Number(segment) : segment;
      return (current as Record<string, unknown> | unknown[])[key as never];
    }, profile);
  if (typeof value === 'string' && value.trim()) return value;

  const countryMatch = path.match(/^education\.(\d+)\.countryRegion$/);
  if (countryMatch) {
    const education = profile.education[Number(countryMatch[1])];
    return resolveEducationCountryRegion(education);
  }
  if (path === 'personal.nationality') return resolvePersonalNationality(profile.personal);
  return value;
}

function isVisualRegionFillMapping(value: unknown): value is VisualRegionFillMapping {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.controlId === 'string'
    && typeof candidate.fieldMeaning === 'string'
    && typeof candidate.matchedProfilePath === 'string'
    && typeof candidate.value === 'string'
  );
}
