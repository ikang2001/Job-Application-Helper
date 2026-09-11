import { FieldType } from './types';

// 字段匹配模式配置
export const FIELD_PATTERNS: Record<string, string[]> = {
  [FieldType.NAME]: [
    'name', '姓名', 'xingming', 'fullname', 'username', 'realname',
    '真实姓名', '申请人姓名', 'applicant', '候选人姓名'
  ],
  [FieldType.GENDER]: [
    'gender', 'sex', '性别', 'xingbie', '男女'
  ],
  [FieldType.BIRTH_DATE]: [
    'birth', 'birthday', 'birthdate', '生日', '出生日期', 'dateofbirth',
    'dob', '出生年月', 'borndate'
  ],
  [FieldType.PHONE_COUNTRY_CODE]: [
    'phonecode', 'phone_code', 'countrycode', 'country_code', 'areacode',
    '国家区号', '国际区号', '手机区号', '电话区号'
  ],
  [FieldType.PHONE]: [
    'phone', 'mobile', 'tel', 'telephone', 'cellphone', 'contact',
    '电话', '手机', '联系电话', '手机号', '联系方式', 'phonenumber'
  ],
  [FieldType.EMAIL]: [
    'email', 'mail', 'e-mail', '邮箱', '电子邮箱', '邮件', 'emailaddress'
  ],
  [FieldType.WECHAT]: [
    'wechat', 'weixin', 'wx', '微信', '微信号', 'wechatid'
  ],
  [FieldType.ID_TYPE]: [
    'idtype', 'id_type', 'identitytype', 'documenttype', '证件类型', '证件类别'
  ],
  [FieldType.ID_CARD]: [
    'idcard', 'identitycard', 'identity', '身份证', '身份证号',
    'idnumber', 'cardnumber', '证件号'
  ],
  [FieldType.NATIONALITY]: [
    'nationality', 'citizenship', '国籍', '国家/地区', '国家或地区'
  ],
  [FieldType.POLITICAL_STATUS]: [
    'politicalstatus', 'political_status', '政治面貌', '政治状态'
  ],
  [FieldType.ETHNICITY]: [
    'ethnicity', 'ethnicgroup', '民族'
  ],
  [FieldType.HOMETOWN]: [
    'hometown', 'nativeplace', 'native_place', '籍贯', '户籍所在地'
  ],
  [FieldType.CURRENT_ADDRESS]: [
    'currentaddress', 'current_address', 'currentlocation', '现居地', '现居住地', '当前所在地'
  ],
  [FieldType.SCHOOL]: [
    'school', 'university', 'college', 'institute', '学校', '院校',
    '毕业院校', '就读学校', 'alma'
  ],
  [FieldType.EDUCATION_COUNTRY]: [
    'educationcountry', 'education_country', 'schoolcountry', 'school_country',
    '所属国家/地区', '学校所在国家', '院校所在国家', '留学国家'
  ],
  [FieldType.SCHOOL_LOCATION]: [
    'schoollocation', 'school_location', 'schooladdress', 'school_address',
    '学校所在地', '学校所在地区', '学校地址', '院校所在地', '院校地址', '校址'
  ],
  [FieldType.COLLEGE]: [
    'college', 'department', 'faculty', 'schoolof', 'institute',
    '学院', '院系', '所在学院', '所属学院', '系别', '院系名称'
  ],
  [FieldType.EDUCATION_TYPE]: [
    'educationtype', 'education_type', 'studytype', '学历类型',
    '学习形式', '学习方式', '培养方式', 'learningtype', '全日制', '非全日制'
  ],
  [FieldType.MAJOR]: [
    'major', 'specialty', 'discipline', 'subject', '专业', '所学专业',
    '专业名称', 'fieldofstudy', 'field_of_study', 'course'
  ],
  [FieldType.DEGREE]: [
    'degree', 'education', 'diploma', 'qualification', '学历', '学位',
    '文凭', '教育程度', 'academicqualification'
  ],
  [FieldType.GPA]: [
    'gpa', 'grade', 'score', 'average', '成绩', '绩点', '平均分',
    '学分绩点', 'gradepoint'
  ],
  [FieldType.LANGUAGE]: [
    'language', 'language_name', '外语语种', '外语类型', '语言类型', '语言名称'
  ],
  [FieldType.LANGUAGE_CERTIFICATE]: [
    'languagecertificate', 'language_certificate', 'languagetest', 'englishlevel',
    '考试类型', '证书类型', '外语证书'
  ],
  [FieldType.LANGUAGE_LEVEL]: [
    'languagelevel', 'language_level', 'englishscore', '外语等级', '语言等级',
    '熟练程度', '语言成绩'
  ],
  [FieldType.SELF_EVALUATION]: [
    'selfevaluation', 'self_evaluation', 'selfassessment', 'personalsummary',
    '自我评价', '个人评价', '个人总结', '个人优势', '自我描述'
  ],
  [FieldType.EDUCATION_START_DATE]: [
    '入学时间', '入学日期', '入学年月', '就读开始', '就读起始',
    '教育开始时间', '教育开始日期', 'educationstart', 'educationstartdate',
    'schoolstart', 'schoolstartdate', 'enrollment', 'enrolment', 'admissiondate'
  ],
  [FieldType.GRADUATION_DATE]: [
    'graduation', 'graduate', 'enddate', '毕业时间', '毕业日期',
    '预计毕业', '毕业年月', 'graduationdate', 'expectedgraduation'
  ],
  [FieldType.COMPANY]: [
    'company', 'employer', 'organization', 'firm', 'corporation',
    '公司', '单位', '工作单位', '雇主', 'workplace'
  ],
  [FieldType.POSITION]: [
    'position', 'title', 'job', 'role', 'post', '职位', '岗位',
    '职务', '工作职位', 'jobtitle'
  ],
  [FieldType.START_DATE]: [
    'startdate', 'start', 'from', 'begin', 'since', '开始时间',
    '起始时间', '开始日期', '入职时间'
  ],
  [FieldType.END_DATE]: [
    'enddate', 'end', 'to', 'until', 'finish', '结束时间',
    '终止时间', '结束日期', '离职时间'
  ],
  [FieldType.DESCRIPTION]: [
    'description', 'desc', 'detail', 'content', 'experience',
    '描述', '详情', '工作内容', '项目描述', '职责描述', 'responsibility'
  ],
  [FieldType.PROJECT_NAME]: [
    'projectname', 'project_name', '项目名称', '课题名称'
  ],
  [FieldType.PROJECT_ROLE]: [
    'projectrole', 'project_role', '项目角色', '项目职务', '担任角色'
  ],
  [FieldType.PROJECT_START_DATE]: [
    'projectstart', 'project_start', '项目开始时间', '项目起始时间'
  ],
  [FieldType.PROJECT_END_DATE]: [
    'projectend', 'project_end', '项目结束时间', '项目终止时间'
  ],
  [FieldType.PROJECT_DESCRIPTION]: [
    'projectdescription', 'project_description', '项目描述', '项目介绍',
    '项目职责', '项目成果'
  ],
  [FieldType.AWARD_NAME]: [
    'awardname', 'award_name', '奖项名称', '荣誉名称', '获奖名称'
  ],
  [FieldType.AWARD_ROLE]: [
    'awardrole', 'award_role', '获奖角色', '奖项角色'
  ],
  [FieldType.AWARD_DATE]: [
    'awarddate', 'award_date', '获奖时间', '获奖日期', '奖项时间'
  ],
  [FieldType.AWARD_DESCRIPTION]: [
    'awarddescription', 'award_description', '奖项描述', '获奖描述', '荣誉描述'
  ],
  [FieldType.SKILLS]: [
    'skill', 'skills', 'ability', 'competency', 'expertise',
    '技能', '专业技能', '掌握技能', '能力', 'technical'
  ],
  [FieldType.RESUME_FILE]: [
    'resume', 'cv', 'curriculum', 'attachment', 'file', 'upload',
    '简历', '附件', '上传', '个人简历', 'document'
  ]
};

// 性别选项映射
export const GENDER_OPTIONS: Record<string, string[]> = {
  male: ['男', 'male', 'M', '先生', 'man'],
  female: ['女', 'female', 'F', '女士', 'woman']
};

// 学历选项映射
export const DEGREE_OPTIONS: Record<string, string[]> = {
  highschool: ['高中', '中专', 'High School'],
  associate: ['专科', '大专', 'Associate'],
  bachelor: ['本科', '学士', 'Bachelor', '大学本科'],
  master: ['硕士', '研究生', 'Master', '硕士研究生'],
  phd: ['博士', 'PhD', 'Doctor', 'Doctorate', '博士研究生']
};

// 政治面貌选项
export const POLITICAL_STATUS_OPTIONS = [
  '中共党员',
  '中共预备党员',
  '共青团员',
  '民主党派',
  '群众'
];

// 常用技能标签
export const COMMON_SKILLS = [
  'JavaScript',
  'TypeScript',
  'React',
  'Vue',
  'Angular',
  'Node.js',
  'Python',
  'Java',
  'C++',
  'Go',
  'HTML/CSS',
  'SQL',
  'Git',
  'Docker',
  'Kubernetes'
];

// 扩展名到MIME类型映射
export const MIME_TYPES: Record<string, string> = {
  'pdf': 'application/pdf',
  'doc': 'application/msword',
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'txt': 'text/plain',
  'md': 'text/markdown'
};

// 支持的文件格式
export const SUPPORTED_FILE_TYPES = ['pdf', 'doc', 'docx', 'txt', 'md'];

// 最大文件大小 (5MB)
export const MAX_FILE_SIZE = 5 * 1024 * 1024;
