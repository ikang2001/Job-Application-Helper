import type { EducationInfo, PersonalInfo } from '../shared/types.ts';

export function resolvePersonalNationality(personal: PersonalInfo): string {
  const explicit = personal.nationality?.trim();
  if (explicit) return explicit;
  if (/居民身份证|中华人民共和国身份证|身份证/.test(personal.idType || '')) return '中国';
  return /^\d{17}[\dXx]$/.test((personal.idCard || '').trim()) ? '中国' : '';
}

export function resolveEducationCountryRegion(education?: EducationInfo): string {
  const explicit = education?.countryRegion?.trim();
  if (explicit) return explicit;

  const educationType = education?.educationType?.trim() || '';
  if (!educationType || /海外|境外|港澳台/.test(educationType)) return '';
  return /统招|全日制|非全日制|自考|成人|成教|函授|普通高等教育/.test(educationType)
    ? '中国'
    : '';
}
