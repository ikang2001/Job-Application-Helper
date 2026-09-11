import { FIELD_PATTERNS } from '../shared/constants';
import { FieldType } from '../shared/types';

/** 只有明确规则命中的字段，才允许 AI 扫描把本地语义当成不可更改的事实。 */
export const AUTHORITATIVE_FIELD_CONFIDENCE = 0.95;

/** 低于此值的模糊结果不进入快速填充，避免把相似字段直接写错。 */
export const DETECTED_FIELD_CONFIDENCE = 0.85;

const AMBIGUOUS_SUBSTRING_PATTERNS = new Set([
  'name',
  'title',
  'role',
  'contact',
  'content',
  'detail',
  'to',
]);

const UNSUPPORTED_PROFILE_FIELD_PATTERN = /姓名拼音|拼音姓名|姓(?:氏)?拼音|名(?:字)?拼音|pinyin|英文名|曾用名|导师|supervisor|advisor|第二专业|辅修专业|第二学位|双学位|secondary\s*major|minor\s*(?:major|degree)|紧急联系人|家庭成员|父亲|母亲|配偶|推荐人|证明人|referee|emergency\s*contact/i;

export function isUnsupportedProfileFieldLabel(value: string): boolean {
  return UNSUPPORTED_PROFILE_FIELD_PATTERN.test(value);
}

export class FieldMatcher {
  // 计算两个字符串的相似度 (Levenshtein距离)
  private static calculateSimilarity(str1: string, str2: string): number {
    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();

    const costs: number[] = [];
    for (let i = 0; i <= s1.length; i++) {
      let lastValue = i;
      for (let j = 0; j <= s2.length; j++) {
        if (i === 0) {
          costs[j] = j;
        } else if (j > 0) {
          let newValue = costs[j - 1];
          if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
            newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
          }
          costs[j - 1] = lastValue;
          lastValue = newValue;
        }
      }
      if (i > 0) {
        costs[s2.length] = lastValue;
      }
    }

    const maxLength = Math.max(s1.length, s2.length);
    return maxLength === 0 ? 1 : 1 - costs[s2.length] / maxLength;
  }

  // 匹配字段类型
  static matchFieldType(
    name: string,
    id: string,
    placeholder: string,
    labelText: string,
    type: string,
    autocomplete: string
  ): { fieldType: FieldType; confidence: number } {
    const searchText = `${name} ${id} ${placeholder} ${labelText} ${autocomplete}`.toLowerCase();
    // extractIdentifiers 会添加这些上下文标记。它们只用于日期等消歧，不能
    // 再参加通用关键词打分，否则 education 会把同一教育行的专业、院系等
    // 全部压成学历字段。
    const semanticSearchText = searchText.replace(/\b(?:education|project|award)-context\b/g, ' ');

    // 这些字段虽然包含“姓名/电话/公司”等字样，但并不是候选人本人的资料。
    // 资料模型没有对应值，宁可交给 AI 后返回空，也不能拿本人信息代填。
    if (isUnsupportedProfileFieldLabel(searchText)) {
      return { fieldType: FieldType.UNKNOWN, confidence: 1.0 };
    }

    // 组合控件必须先于通用手机号、证件号和语言规则判断。部分站点会把
    // 两个子控件放在同一个表单项里，仅靠外层 label 会把两边填成相同值。
    if (/国家区号|国际区号|手机区号|电话区号|phone[_\s-]?code|country[_\s-]?code|area[_\s-]?code/.test(searchText)) {
      return { fieldType: FieldType.PHONE_COUNTRY_CODE, confidence: 1.0 };
    }
    if (/证件类型|证件类别|id[_\s-]?type|identity[_\s-]?type|document[_\s-]?type/.test(searchText)) {
      return { fieldType: FieldType.ID_TYPE, confidence: 1.0 };
    }
    if (/(?:身份证|证件|身份)(?:号|号码)|id[_\s-]?(?:number|card)|identity[_\s-]?(?:number|card)|document[_\s-]?number|card[_\s-]?number/.test(searchText)) {
      return { fieldType: FieldType.ID_CARD, confidence: 1.0 };
    }
    if (/外语证书|语言证书|考试类型|language[_\s-]?(?:certificate|test)|english[_\s-]?level/.test(searchText)) {
      return { fieldType: FieldType.LANGUAGE_CERTIFICATE, confidence: 1.0 };
    }
    if (/外语等级|语言等级|熟练程度|语言成绩|language[_\s-]?(?:level|score)|english[_\s-]?score/.test(searchText)) {
      return { fieldType: FieldType.LANGUAGE_LEVEL, confidence: 1.0 };
    }
    if (/外语语种|外语类型|语言类型|语言名称|language[_\s-]?name/.test(searchText)) {
      return { fieldType: FieldType.LANGUAGE, confidence: 1.0 };
    }

    if (/国籍(?:\s*[/／]\s*地区)?|nationality|citizenship/.test(searchText)) {
      return { fieldType: FieldType.NATIONALITY, confidence: 1.0 };
    }

    if (/籍贯|户籍|户口所在地|hometown|nativeplace|native_place|place[_\s-]?of[_\s-]?origin/.test(searchText)) {
      return { fieldType: FieldType.HOMETOWN, confidence: 1.0 };
    }

    if (
      /所属国家\s*[/／]\s*地区|学校所在国家|院校所在国家|留学国家|(?:education|school)[_\s-]?(?:country|region)/.test(searchText)
      || (/education-context/.test(searchText) && /国家\s*[/／]\s*地区|国家或地区|country|region/.test(searchText))
    ) {
      return { fieldType: FieldType.EDUCATION_COUNTRY, confidence: 1.0 };
    }

    if (
      /学校(?:所在)?(?:地|地区|城市|地址|地点)|院校(?:所在)?(?:地|地区|城市|地址|地点)|校址|school[_\s-]?(?:location|address)|campus[_\s-]?location/.test(searchText)
    ) {
      return { fieldType: FieldType.SCHOOL_LOCATION, confidence: 1.0 };
    }

    // 常见后端字段会带 Name 后缀，需在通用 name 规则前确定业务含义。
    if (/school[_\s-]?name|学校名称|毕业学校|就读学校/.test(searchText)) {
      return { fieldType: FieldType.SCHOOL, confidence: 1.0 };
    }
    if (/college[_\s-]?name|department[_\s-]?name|faculty[_\s-]?name|学院名称|院系名称|所在学院|所属学院/.test(searchText)) {
      return { fieldType: FieldType.COLLEGE, confidence: 1.0 };
    }
    if (/major[_\s-]?name|专业名称|所学专业/.test(searchText)) {
      return { fieldType: FieldType.MAJOR, confidence: 1.0 };
    }
    if (/(?:^|\s)(?:faculty|department|院系|学院)(?:\s|$)/.test(semanticSearchText)) {
      return { fieldType: FieldType.COLLEGE, confidence: 0.98 };
    }
    if (/(?:^|\s)(?:major|specialty|专业|主修专业)(?:\s|$)/.test(semanticSearchText)) {
      return { fieldType: FieldType.MAJOR, confidence: 0.98 };
    }

    const hasProjectContext = /项目|课题|project/.test(searchText);
    if (hasProjectContext) {
      if (/结束|终止|to|end|finish/.test(searchText)) {
        return { fieldType: FieldType.PROJECT_END_DATE, confidence: 0.98 };
      }
      if (/开始|起始|from|begin|start/.test(searchText)) {
        return { fieldType: FieldType.PROJECT_START_DATE, confidence: 0.98 };
      }
      if (/职责|描述|介绍|成果|内容|responsibil|description|detail|performance/.test(searchText)) {
        return { fieldType: FieldType.PROJECT_DESCRIPTION, confidence: 0.98 };
      }
      if (/角色|职务|担任|role/.test(searchText)) {
        return { fieldType: FieldType.PROJECT_ROLE, confidence: 0.98 };
      }
      if (/名称|名字|标题|name|title/.test(searchText)) {
        return { fieldType: FieldType.PROJECT_NAME, confidence: 0.98 };
      }
    }

    if (/工作描述|工作内容|实习描述|职责描述|主要职责|work[_\s-]?(?:description|content)|job[_\s-]?description/.test(searchText)) {
      return { fieldType: FieldType.DESCRIPTION, confidence: 1.0 };
    }

    if (/company[_\s-]?name|employer[_\s-]?name|公司名称|单位名称/.test(searchText)) {
      return { fieldType: FieldType.COMPANY, confidence: 1.0 };
    }
    if (/position[_\s-]?name|job[_\s-]?title|岗位名称|职位名称|任职岗位/.test(searchText)) {
      return { fieldType: FieldType.POSITION, confidence: 1.0 };
    }
    if (/candidate[_\s-]?name|applicant[_\s-]?name|候选人姓名|申请人姓名/.test(searchText)) {
      return { fieldType: FieldType.NAME, confidence: 1.0 };
    }

    const exactIdentifiers = [name, id, placeholder, labelText, autocomplete]
      .map(value => value.toLowerCase().replace(/[\s_-]/g, ''))
      .filter(Boolean);
    if (exactIdentifiers.some(value => [
      'name', 'fullname', 'realname', '姓名', '真实姓名',
    ].includes(value))) {
      return { fieldType: FieldType.NAME, confidence: 0.98 };
    }

    // 特殊类型直接匹配
    if (type === 'email') {
      return { fieldType: FieldType.EMAIL, confidence: 1.0 };
    }
    if (type === 'tel') {
      return { fieldType: FieldType.PHONE, confidence: 1.0 };
    }
    if (type === 'date') {
      if (searchText.includes('birth')) {
        return { fieldType: FieldType.BIRTH_DATE, confidence: 0.9 };
      }
    }
    if (type === 'file') {
      return { fieldType: FieldType.RESUME_FILE, confidence: 0.8 };
    }

    // 字节等站点会使用 education_type 作为学历类型字段名。
    // 必须在通用的 education/school 模式前精确判断，避免被误识别成学校。
    if (/学历类型|学习形式|学习方式|培养方式|education[_\s-]?type|study[_\s-]?type|learning[_\s-]?type/.test(searchText)) {
      return { fieldType: FieldType.EDUCATION_TYPE, confidence: 1.0 };
    }
    if (/学历(?!类型)|学位|(?:^|[\s_-])degree(?:[\s_-]|$)|academic[_\s-]?qualification/.test(searchText)) {
      return { fieldType: FieldType.DEGREE, confidence: 1.0 };
    }

    const hasEducationContext = /教育|学校|院校|大学|学院|就读|入学|毕业|education|school|university|college|academic|enroll|enrol|admission/.test(searchText);
    const hasWorkContext = /工作|实习|公司|单位|入职|离职|岗位|职位|work|job|company|employer|intern|employment/.test(searchText);
    if (hasEducationContext && !hasWorkContext) {
      if (/结束|毕业|预计毕业|to|end|finish|graduate|graduation/.test(searchText)) {
        return { fieldType: FieldType.GRADUATION_DATE, confidence: 0.95 };
      }
      if (/开始|起始|入学|就读开始|from|begin|enroll|enrol|admission|educationstart/.test(searchText)) {
        return { fieldType: FieldType.EDUCATION_START_DATE, confidence: 0.95 };
      }
    }

    if (hasWorkContext && !hasEducationContext) {
      if (/结束|离职|结束时间|to|end|finish/.test(searchText)) {
        return { fieldType: FieldType.END_DATE, confidence: 0.95 };
      }
      if (/开始|起始|入职|开始时间|from|begin|startdate/.test(searchText)) {
        return { fieldType: FieldType.START_DATE, confidence: 0.95 };
      }
    }

    const hasAwardContext = /奖项|获奖|荣誉|award|honou?r/.test(searchText);
    if (hasAwardContext) {
      if (/名称|名字|name|title/.test(searchText)) {
        return { fieldType: FieldType.AWARD_NAME, confidence: 0.98 };
      }
      if (/角色|担任|role/.test(searchText)) {
        return { fieldType: FieldType.AWARD_ROLE, confidence: 0.98 };
      }
      if (/时间|日期|date|time/.test(searchText)) {
        return { fieldType: FieldType.AWARD_DATE, confidence: 0.98 };
      }
      if (/描述|详情|description|detail/.test(searchText)) {
        return { fieldType: FieldType.AWARD_DESCRIPTION, confidence: 0.98 };
      }
    }

    // 遍历所有字段模式进行匹配。不能再使用“第一个包含项获胜”：name、title
    // 等短词会覆盖 nationalityName、collegeName 之类更具体的业务字段。
    let bestMatch = { fieldType: FieldType.UNKNOWN, confidence: 0 };
    let bestPatternLength = 0;

    for (const [fieldType, patterns] of Object.entries(FIELD_PATTERNS)) {
      for (const pattern of patterns) {
        const normalizedPattern = pattern.toLowerCase();

        // 精确匹配
        if (
          semanticSearchText.includes(normalizedPattern)
          && !AMBIGUOUS_SUBSTRING_PATTERNS.has(normalizedPattern)
        ) {
          const patternLength = normalizedPattern.replace(/[\s_-]/g, '').length;
          const confidence = Math.min(0.94, 0.88 + patternLength * 0.005);
          if (
            confidence > bestMatch.confidence
            || (confidence === bestMatch.confidence && patternLength > bestPatternLength)
          ) {
            bestMatch = { fieldType: fieldType as FieldType, confidence };
            bestPatternLength = patternLength;
          }
        }

        // 模糊匹配
        const similarity = this.calculateSimilarity(semanticSearchText, pattern);
        if (similarity > 0.85 && similarity > bestMatch.confidence) {
          bestMatch = { fieldType: fieldType as FieldType, confidence: similarity };
          bestPatternLength = normalizedPattern.length;
        }
      }
    }

    return bestMatch;
  }

  private static extractModuleContext(module: HTMLElement | null): string {
    if (!module) return '';

    const stableIdentifiers = [
      module.getAttribute('data-form-module'),
      module.getAttribute('data-section'),
      module.getAttribute('data-module'),
      module.getAttribute('aria-label'),
      module.getAttribute('class'),
    ];
    const labelledBy = module.getAttribute('aria-labelledby');
    const labelledText = labelledBy
      ?.split(/\s+/)
      .map(id => module.ownerDocument?.getElementById(id)?.textContent || '')
      .join(' ');
    const headingText = module.querySelector(
      ':scope > legend, :scope > [role="heading"], :scope > h1, :scope > h2, ' +
      ':scope > h3, :scope > h4, :scope > h5, :scope > h6, ' +
      'legend, [role="heading"], h1, h2, h3, h4, h5, h6, ' +
      '.ihr_recruit_resume_title_main-content'
    )?.textContent;

    return [...stableIdentifiers, labelledText, headingText]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 从元素中提取所有可能的标识符
  static extractIdentifiers(
    element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  ): {
    name: string;
    id: string;
    placeholder: string;
    labelText: string;
    type: string;
    autocomplete: string;
  } {
    const fieldContainer = element.closest<HTMLElement>(
      '[data-form-field-id], [data-form-field-name], [data-form-field-i18n-name], ' +
      '.md-form-item, .el-form-item, .ant-form-item, .arco-form-item, ' +
      '.form-group, [data-field], [class*=field-wrapper], ' +
      '[class*=formItem], [class*=applyFormItem], [class*=resume_person_info-], ' +
      '[class*=school_resume_person_info-], [class*=recruit_resume_person_info-]'
    );
    const elementDataId = element.getAttribute('data-form-field-id') || '';
    const elementDataName = element.getAttribute('data-form-field-name') || '';
    const elementDataI18nName = element.getAttribute('data-form-field-i18n-name') || '';
    const containerDataId = fieldContainer?.getAttribute('data-form-field-id') || '';
    const containerDataName = fieldContainer?.getAttribute('data-form-field-name') || '';
    const containerDataI18nName = fieldContainer?.getAttribute('data-form-field-i18n-name') || '';

    const name = [
      element.getAttribute('name') || '',
      elementDataName,
      elementDataId,
      containerDataName,
      containerDataId,
    ].filter(Boolean).join(' ');
    const id = [
      element.id || '',
      elementDataId,
      containerDataId,
    ].filter(Boolean).join(' ');
    const placeholder = element.getAttribute('placeholder') || '';
    const type = element.getAttribute('type') || '';
    const autocomplete = element.getAttribute('autocomplete') || '';

    // 查找关联的 label
    let labelText = '';
    if (id) {
      const label = element.id ? document.querySelector(`label[for="${element.id}"]`) : null;
      if (label) {
        labelText = label.textContent || '';
      }
    }

    if (!labelText && fieldContainer) {
      const label = fieldContainer.querySelector(
        '.ud-formily-item-label label, .ud-formily-item-label, ' +
        '.md-form-item__label, .el-form-item__label, .ant-form-item-label, ' +
        '.arco-form-item-label, label, [class*=label]'
      );
      if (label) {
        labelText = label.textContent || '';
      }
    }

    // 如果没有找到 label[for]，尝试找父级 label
    if (!labelText) {
      const parentLabel = element.closest('label');
      if (parentLabel) {
        labelText = parentLabel.textContent || '';
      }
    }

    // 如果还是没有，查找前面的兄弟节点
    if (!labelText) {
      let prevSibling = element.previousElementSibling;
      while (prevSibling) {
        if (prevSibling.tagName === 'LABEL' || prevSibling.tagName === 'SPAN') {
          labelText = prevSibling.textContent || '';
          break;
        }
        prevSibling = prevSibling.previousElementSibling;
      }
    }

    if (!labelText) {
      labelText = [elementDataI18nName, containerDataI18nName].filter(Boolean).join(' ');
    }

    labelText = this.addCompoundControlSemantics(element, fieldContainer, labelText);

    const moduleContainer = element.closest<HTMLElement>(
      '[data-form-module], [data-section], [data-module], [class*=applyFormModuleWrapper], ' +
      '[class*=ihr_recruit_resume-block]'
    );
    const moduleContext = this.extractModuleContext(moduleContainer);
    const contextText = `${moduleContext} ${labelText} ${name} ${id}`;

    if (/奖项|荣誉|获奖|award|honou?r/i.test(moduleContext)) {
      labelText = `${labelText} award-context 奖项`;
    }
    if (/项目|课题|project/i.test(moduleContext)) {
      labelText = `${labelText} project-context 项目`;
    }
    if (/教育经历|学历类型|学校名称|院系|导师|(?:^|[-_])edu(?:[-_]|$)|education/i.test(moduleContext)) {
      labelText = `${labelText} education-context 教育经历`;
    }

    if (fieldContainer && /起止时间|学习时间|工作时间|项目时间|date range|start.*end|start_end/i.test(`${labelText} ${name} ${id}`)) {
      const fieldsInContainer = Array.from(
        fieldContainer.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
          'input:not([type="hidden"]), textarea, select'
        )
      );
      const fieldIndex = fieldsInContainer.indexOf(element);
      const isEducationRange = /教育经历|学历类型|学校名称|学院|导师|(?:^|[-_])edu(?:[-_]|$)/i.test(contextText);
      const isWorkRange = /实习经历|工作经历|公司名称|职位名称|没有实习经历|internship/i.test(contextText);
      const isProjectRange = /项目经历|项目名称|项目角色|project/i.test(contextText);

      if (isEducationRange && fieldIndex === 0) {
        labelText = `${labelText} 入学时间 educationstart`;
      } else if (isEducationRange && fieldIndex === 1) {
        labelText = `${labelText} 毕业时间 graduation`;
      } else if (isWorkRange && fieldIndex === 0) {
        labelText = `${labelText} 开始时间 startdate`;
      } else if (isWorkRange && fieldIndex === 1) {
        labelText = `${labelText} 结束时间 enddate`;
      } else if (isProjectRange && fieldIndex === 0) {
        labelText = `${labelText} 项目开始时间 projectstart`;
      } else if (isProjectRange && fieldIndex === 1) {
        labelText = `${labelText} 项目结束时间 projectend`;
      }
    }

    return { name, id, placeholder, labelText, type, autocomplete };
  }

  static extractRowIndex(
    element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  ): number | undefined {
    const row = element.closest<HTMLElement>(
      '[data-repeat-index], [data-row-index], [class*=multiple_form-edu-], ' +
      '[class*=multiple_form-internship-], [class*=multiple_form-project-], ' +
      '[class*=multiple_form-language-], [class*=education-row-], ' +
      '[class*=experience-row-], [class*=language-row-]'
    );
    if (!row) {
      const fieldPath = [
        element.getAttribute?.('name') || '',
        element.getAttribute?.('id') || '',
        element.getAttribute?.('data-form-field-name') || '',
        element.getAttribute?.('data-form-field-id') || '',
      ].join(' ');
      const pathMatch = fieldPath.match(
        /(?:education|educations|school|experience|experiences|internship|internships|project|projects|language|languages)(?:\.|\[|_|-)+(\d+)(?:\]|\.|_|-|$)/i
      );
      return pathMatch ? Number(pathMatch[1]) : undefined;
    }

    for (const attribute of ['data-repeat-index', 'data-row-index']) {
      const raw = row.getAttribute(attribute);
      if (raw !== null && /^\d+$/.test(raw)) return Number(raw);
    }

    const className = row.getAttribute('class') || '';
    const match = className.match(
      /(?:multiple_form-(?:edu|internship|project|language)|education-row|experience-row|language-row)-(\d+)(?:\s|$)/i
    );
    return match ? Number(match[1]) : undefined;
  }

  private static addCompoundControlSemantics(
    element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    fieldContainer: HTMLElement | null,
    labelText: string
  ): string {
    const normalizedLabel = labelText.replace(/\s+/g, ' ').trim();
    const isPickerInput = element.tagName === 'SELECT' || Boolean(element.closest(
      '.ud__select, .ihr_base_picker, .ihr_base_selector, .ihr_dict_picker, ' +
      '.ihr_base_cascader, .ihr_cascader, .ihr_area_picker, .ihr_tree_picker, ' +
      '.ihr_input_selector, .md-select, .md-cascader, .md-tree-select, ' +
      '.ant-select, .arco-select, .el-select, .ng-select, ' +
      '.MuiAutocomplete-root, .MuiSelect-root, .ant-cascader, .el-cascader, ' +
      '.arco-cascader, [class*=cascader], [class*=Cascader], [class*=cascade], ' +
      '[class*=tree-select], [class*=treeSelect], [class*=area-picker], ' +
      '[class*=region-picker], [role="combobox"]'
    ));
    const isLeadingPicker = isPickerInput
      && this.isLeadingCompoundControl(element, fieldContainer);

    if (/手机|电话|phone|mobile/i.test(normalizedLabel)) {
      if (
        isLeadingPicker
        || element.closest('.md-input-group__prepend, [class*=phone-code], [class*=phone_code]')
      ) {
        return `${normalizedLabel} 国家区号 phoneCode`;
      }
      return `${normalizedLabel} 手机号码 phone`;
    }

    if (/证件|身份证|id\s*(?:number|card)/i.test(normalizedLabel)) {
      if (isPickerInput && (
        isLeadingPicker
        || element.closest(
          '.ihr_recruit_resume_person_info-idNumber, .ihr_school_resume_person_info-idNumber, ' +
          '[class*=idNumber], [class*=id-number]'
        )
      )) {
        return `${normalizedLabel} 证件类型 idType`;
      }
      return `${normalizedLabel} 证件号码 idNumber`;
    }

    if (/外语类型|语言类型/i.test(normalizedLabel)) {
      const group = element.closest<HTMLElement>('.code_group-select, [class*=language-group]');
      const pickerInputs = group
        ? Array.from(group.querySelectorAll<HTMLInputElement>(
          'input.ihr_base_picker-search_input, input.ihr_base_selector-search_input, ' +
          '.ihr_dict_picker input, ' +
          '.md-select input, .md-cascader input, .md-tree-select input, ' +
          '.ihr_area_picker input, .ihr_tree_picker input, ' +
          'input[role="combobox"], .ant-select input, .arco-select input, .el-select input'
        ))
        : [];
      const index = pickerInputs.indexOf(element as HTMLInputElement);
      if (index > 0) return `${normalizedLabel} 外语证书 考试类型 languageCertificate`;
      return `${normalizedLabel} 外语语种 languageName`;
    }

    return normalizedLabel;
  }

  private static isLeadingCompoundControl(
    element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    fieldContainer: HTMLElement | null,
  ): boolean {
    if (!fieldContainer || typeof fieldContainer.querySelectorAll !== 'function') return false;
    const controls = Array.from(fieldContainer.querySelectorAll(
      'input:not([type="hidden"]), textarea, select',
    ));
    return controls.length > 1 && controls[0] === element;
  }
}
