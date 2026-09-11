import type { EducationInfo, UserProfile } from '../shared/types.ts';
import { NLPHelper } from './nlpHelper.ts';

/**
 * 附件解析结果只补全资料库中仍为空的教育字段，不覆盖用户已经在插件里保存的值。
 * 这让旧版本漏掉的“自动化（本科）”等紧邻学历的专业在填表时立即可用。
 */
export function buildAuthoritativeFillProfile(profile: UserProfile): UserProfile {
  const resumeText = profile.resume?.parsedText?.trim();
  if (!resumeText || profile.education.length === 0) return profile;

  const parsedEducation = NLPHelper.parseResumeText(resumeText).education || [];
  if (parsedEducation.length === 0) return profile;

  let changed = false;
  const education = profile.education.map(item => {
    const parsed = findMatchingEducation(item, parsedEducation);
    if (!parsed) return item;

    const enriched = {
      ...item,
      major: item.major || parsed.major || '',
      degree: item.degree || parsed.degree || '',
      startDate: item.startDate || parsed.startDate || '',
      endDate: item.endDate || parsed.endDate || '',
      ...(!item.college && parsed.college ? { college: parsed.college } : {}),
    };
    if (JSON.stringify(enriched) !== JSON.stringify(item)) changed = true;
    return enriched;
  });

  return changed ? { ...profile, education } : profile;
}

function findMatchingEducation(
  education: EducationInfo,
  candidates: Partial<EducationInfo>[],
): Partial<EducationInfo> | undefined {
  const school = normalizeSchoolName(education.school);
  if (!school) return undefined;
  return candidates.find(candidate => normalizeSchoolName(candidate.school || '') === school);
}

function normalizeSchoolName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s·,，、_-]/g, '');
}
