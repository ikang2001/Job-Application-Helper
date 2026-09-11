const GENERIC_JOB_TITLE_LABELS = new Set([
  'career',
  'careers',
  'job',
  'jobs',
  'job application',
  'job details',
  'job opportunities',
  'position details',
  'apply now',
  'submit application',
  '职位',
  '职位详情',
  '职位申请',
  '职位投递',
  '岗位',
  '岗位详情',
  '岗位申请',
  '招聘',
  '招聘职位',
  '校园招聘',
  '社会招聘',
  '投递',
  '投递岗位',
  '投递职位',
  '申请',
  '申请岗位',
  '申请职位',
  '提交申请',
  '立即申请',
  '立即投递',
]);

export function isGenericJobTitleLabel(value: string): boolean {
  return GENERIC_JOB_TITLE_LABELS.has(value.replace(/\s+/g, ' ').trim().toLowerCase());
}

export function isSubmissionFlowUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /(?:^|[/_.?&=#-])(?:apply|application|form|resume|submit|success|complete|thank)(?:$|[/_.?&=#-])/i
      .test(`${url.pathname}${url.search}${url.hash}`);
  } catch {
    return false;
  }
}

export function isLikelyJobDetailUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || isSubmissionFlowUrl(value)) return false;
    const hasJobQuery = Array.from(url.searchParams.keys()).some(key => (
      /^(?:gh_jid|jid|job_?id|jobadid|position_?id|req(?:uisition)?_?id)$/i.test(key)
    ));
    return hasJobQuery
      || /(?:^|[/_.-])(?:jobs?|positions?|requisitions?|jobdetails?|job-detail|detail)(?:$|[/_.-])/i
        .test(url.pathname);
  } catch {
    return false;
  }
}
