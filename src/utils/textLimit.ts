export function findTextLengthLimit(
  declaredMaxLength: number,
  hintText: string,
): number | null {
  if (Number.isInteger(declaredMaxLength) && declaredMaxLength > 0) {
    return declaredMaxLength;
  }

  const normalizedHint = hintText.replace(/\s+/g, ' ').trim();
  const explicitMatch = normalizedHint.match(/最多可输入\s*(\d+)\s*(?:个)?(?:字|字符)/);
  if (explicitMatch) return toPositiveInteger(explicitMatch[1]);

  const counterMatch = normalizedHint.match(/\b\d+\s+\/\s+(\d+)\s*(?=最多|(?:个)?(?:字|字符)|$)/);
  return counterMatch ? toPositiveInteger(counterMatch[1]) : null;
}

export function truncateToTextLength(value: string, limit: number | null): string {
  if (!limit || value.length <= limit) return value;
  return value.slice(0, limit);
}

function toPositiveInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
