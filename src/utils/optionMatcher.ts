const EDUCATION_MODE_PATTERNS: Array<[string, RegExp]> = [
  ['part-time', /非全日制|非统招|在职|业余|函授|part\s*time/i],
  ['full-time', /全日制|统招|普通高等教育|普通高校|全脱产|full\s*time/i],
  ['self-study', /自考|自学考试/i],
  ['adult', /成人教育|成人高考|成教/i],
  ['overseas', /海外|港澳台|境外/i],
];

const DEGREE_PATTERNS: Array<[string, RegExp]> = [
  ['phd', /博士|ph\.?d|doctor/i],
  ['master', /硕士|研究生|master/i],
  ['bachelor', /本科|学士|bachelor/i],
  ['associate', /专科|大专|associate/i],
  ['high-school', /高中|中专|high\s*school/i],
];

const GENDER_PATTERNS: Array<[string, RegExp]> = [
  ['male', /^(?:男|男性|先生|m|male)$/i],
  ['female', /^(?:女|女性|女士|f|female)$/i],
];

const ID_TYPE_PATTERNS: Array<[string, RegExp]> = [
  ['hong-kong-id', /香港.*(?:身份证|居民证)|港澳居民居住证/i],
  ['macao-id', /澳门.*(?:身份证|居民证)/i],
  ['taiwan-id', /台湾.*(?:身份证|居民证)|台胞证|台湾居民来往大陆通行证/i],
  ['mainland-id', /居民身份证|中华人民共和国身份证|中国大陆身份证|大陆身份证|身份证/i],
  ['passport', /护照|passport/i],
];

const POLITICAL_STATUS_PATTERNS: Array<[string, RegExp]> = [
  ['probationary-party-member', /中共预备党员|中国共产党预备党员/i],
  ['party-member', /中共党员|中国共产党党员/i],
  ['league-member', /共青团员|中国共产主义青年团团员/i],
  ['democratic-party', /民主党派/i],
  ['nonpartisan', /无党派/i],
  ['masses', /群众|普通群众/i],
];

const LANGUAGE_PATTERNS: Array<[string, RegExp]> = [
  ['english', /^(?:英语|英文|english)$/i],
  ['chinese', /^(?:汉语|中文|普通话|chinese|mandarin)$/i],
  ['japanese', /^(?:日语|日文|japanese)$/i],
  ['korean', /^(?:韩语|朝鲜语|korean)$/i],
  ['french', /^(?:法语|french)$/i],
  ['german', /^(?:德语|german)$/i],
  ['spanish', /^(?:西班牙语|spanish)$/i],
];

const LANGUAGE_LEVEL_PATTERNS: Array<[string, RegExp]> = [
  ['native', /母语|native/i],
  ['expert', /精通|expert/i],
  ['proficient', /熟练|流利|proficient|fluent/i],
  ['good', /良好|good/i],
  ['intermediate', /中等|一般|intermediate/i],
  ['basic', /基础|入门|basic/i],
  ['passed', /通过|合格|pass(?:ed)?/i],
];

const LANGUAGE_CERTIFICATE_PATTERNS: Array<[string, RegExp]> = [
  ['cet-4', /大学英语四级|英语四级|cet[-\s]?4/i],
  ['cet-6', /大学英语六级|英语六级|cet[-\s]?6/i],
  ['tem-4', /英语专业四级|专业四级|tem[-\s]?4/i],
  ['tem-8', /英语专业八级|专业八级|tem[-\s]?8/i],
  ['ielts', /雅思|ielts/i],
  ['toefl', /托福|toefl/i],
];

const COUNTRY_REGION_PATTERNS: Array<[string, RegExp]> = [
  ['china', /^(?:中国|中国大陆|中华人民共和国|china|chinese|cn)$/i],
  ['hong-kong', /^(?:中国)?香港|hong\s*kong|hk$/i],
  ['macao', /^(?:中国)?澳门|maca[ou]|mo$/i],
  ['taiwan', /^(?:中国)?台湾|taiwan|tw$/i],
];

export function findBestMatchingOptionIndex(
  expected: string,
  options: readonly string[],
): number {
  let bestIndex = -1;
  let bestScore = 0;

  options.forEach((option, index) => {
    const score = scoreOptionMatch(option, expected);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  });

  return bestIndex;
}

export function areEquivalentOptionValues(actual: string, expected: string): boolean {
  return scoreOptionMatch(actual, expected) >= 70;
}

export function scoreOptionMatch(option: string, expected: string): number {
  const normalizedOption = normalizeOptionValue(option);
  const normalizedExpected = normalizeOptionValue(expected);
  if (!normalizedOption || !normalizedExpected) return 0;
  if (normalizedOption === normalizedExpected) return 100;

  // 院校名称不可按包含关系猜选：“西北工业大学明德学院”并非“西北工业大学”。
  // 只容忍上面已经消除的空白、大小写和常见标点差异。
  if (/(?:大学|学院|university|college|institute)/i.test(expected)
    && /(?:大学|学院|university|college|institute)/i.test(option)
    && !/英语|四级|六级|cet/i.test(expected)) return 0;

  const numericRangeScore = scoreNumericRange(option, expected);
  if (numericRangeScore !== null) return numericRangeScore;

  const educationModeScore = scoreBySemanticGroup(
    option,
    expected,
    EDUCATION_MODE_PATTERNS,
  );
  if (educationModeScore !== null) return educationModeScore;

  const degreeScore = scoreBySemanticGroup(option, expected, DEGREE_PATTERNS);
  if (degreeScore !== null) return degreeScore;

  const genderScore = scoreBySemanticGroup(option, expected, GENDER_PATTERNS);
  if (genderScore !== null) return genderScore;

  const idTypeScore = scoreBySemanticGroup(option, expected, ID_TYPE_PATTERNS);
  if (idTypeScore !== null) return idTypeScore;

  const politicalStatusScore = scoreBySemanticGroup(
    option,
    expected,
    POLITICAL_STATUS_PATTERNS,
  );
  if (politicalStatusScore !== null) return politicalStatusScore;

  const languageScore = scoreBySemanticGroup(option, expected, LANGUAGE_PATTERNS);
  if (languageScore !== null) return languageScore;

  const languageCertificateScore = scoreBySemanticGroup(
    option,
    expected,
    LANGUAGE_CERTIFICATE_PATTERNS,
  );
  if (languageCertificateScore !== null) return languageCertificateScore;

  const languageLevelScore = scoreBySemanticGroup(
    option,
    expected,
    LANGUAGE_LEVEL_PATTERNS,
  );
  if (languageLevelScore !== null) return languageLevelScore;

  const countryRegionScore = scoreBySemanticGroup(option, expected, COUNTRY_REGION_PATTERNS);
  if (countryRegionScore !== null) return countryRegionScore;

  if (hasExplicitCountryCode(option) || hasExplicitCountryCode(expected)) {
    const optionCountryCode = extractCountryCode(option);
    const expectedCountryCode = extractCountryCode(expected);
    if (optionCountryCode && expectedCountryCode) {
      return optionCountryCode === expectedCountryCode ? 90 : 0;
    }
  }

  if (hasOppositeQualifier(option, expected)) return 0;
  if (
    normalizedOption.includes(normalizedExpected)
    || normalizedExpected.includes(normalizedOption)
  ) {
    const lengthDifference = Math.abs(normalizedOption.length - normalizedExpected.length);
    return Math.max(70, 84 - lengthDifference);
  }

  return 0;
}

function scoreBySemanticGroup(
  actual: string,
  expected: string,
  patterns: Array<[string, RegExp]>,
): number | null {
  const actualGroup = matchSemanticGroup(actual, patterns);
  const expectedGroup = matchSemanticGroup(expected, patterns);
  if (!actualGroup && !expectedGroup) return null;
  if (!actualGroup || !expectedGroup) return 0;
  return actualGroup === expectedGroup ? 92 : 0;
}

function matchSemanticGroup(value: string, patterns: Array<[string, RegExp]>): string | null {
  return patterns.find(([, pattern]) => pattern.test(value))?.[0] || null;
}

function extractCountryCode(value: string): string | null {
  const match = value.trim().match(/^(?:\+|00)?(\d{1,4})(?=\D|$)/);
  return match ? match[1] : null;
}

function hasExplicitCountryCode(value: string): boolean {
  return /^(?:\+|00)\d/.test(value.trim());
}

function hasOppositeQualifier(actual: string, expected: string): boolean {
  const negativePattern = /非|未|无|否|not|non[-\s]?/i;
  return negativePattern.test(actual) !== negativePattern.test(expected);
}

function scoreNumericRange(option: string, expected: string): number | null {
  const expectedMatch = expected.trim().match(/^(\d+(?:\.\d+)?)\s*(?:分|分数)?$/);
  if (!expectedMatch) return null;

  const rangeMatch = option.trim().match(
    /^(\d+(?:\.\d+)?)\s*(?:~|～|—|–|-|至|到)\s*(\d+(?:\.\d+)?)\s*(?:分|分数)?$/,
  );
  if (!rangeMatch) return null;

  const score = Number(expectedMatch[1]);
  const lower = Number(rangeMatch[1]);
  const upper = Number(rangeMatch[2]);
  return score >= Math.min(lower, upper) && score <= Math.max(lower, upper) ? 95 : 0;
}

function normalizeOptionValue(value: string): string {
  return value.toLowerCase().replace(/[\s（）()·,，./_+\-:：]/g, '');
}
