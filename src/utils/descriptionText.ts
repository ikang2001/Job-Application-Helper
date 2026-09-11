const STRUCTURED_LINE_PATTERN = /^(?:[-•·▪◦] *|(?:\d+|[一-十]+)[、.．,，：:]\s*|[（(]\s*(?:\d+|[a-z])\s*[）)]\s*)/i;
const SHORT_ITEM_TITLE_PATTERN = /^\d+[、.．,，]\s*/;
const HEADING_LINE_PATTERN = /^(?:项目|工作|职责|成果|背景|业绩|核心职责|主要工作)[：:]/;

/**
 * 合并 PDF/Word 视觉换行造成的断句，同时保留编号条目的分行。
 * 网申文本框通常较窄，浏览器会自动折行，不需要保留简历版面的硬换行。
 */
export function normalizeDescriptionText(value: string): string {
  const lines = value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[\t\u00a0\u3000]+/g, ' ').replace(/ {2,}/g, ' ').trim())
    .filter(Boolean);

  const paragraphs: string[] = [];
  for (const line of lines) {
    const previous = paragraphs.at(-1) || '';
    if (
      paragraphs.length === 0
      || STRUCTURED_LINE_PATTERN.test(line)
      || HEADING_LINE_PATTERN.test(line)
      || (SHORT_ITEM_TITLE_PATTERN.test(previous) && previous.length <= 60)
    ) {
      paragraphs.push(line);
      continue;
    }

    const lastIndex = paragraphs.length - 1;
    paragraphs[lastIndex] += needsAsciiSpace(paragraphs[lastIndex], line) ? ` ${line}` : line;
  }

  return paragraphs.join('\n').trim();
}

function needsAsciiSpace(left: string, right: string): boolean {
  return /[a-z\d]$/i.test(left) && /^[a-z\d]/i.test(right);
}
