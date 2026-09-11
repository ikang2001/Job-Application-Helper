import type { EmailAddress } from './types.ts';

export function parseEmailAddress(value: string): EmailAddress {
  const trimmed = value.trim();
  const angle = trimmed.match(/^\s*(?:"([^"]*)"|([^<]*?))?\s*<\s*([^>]+)\s*>\s*$/);
  if (angle) {
    const name = (angle[1] ?? angle[2] ?? '').trim();
    return {
      ...(name ? { name } : {}),
      address: normalizeAddress(angle[3] ?? ''),
    };
  }
  return { address: normalizeAddress(trimmed) };
}

export function splitEmailAddresses(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let inQuotes = false;
  let angleDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"' && value[index - 1] !== '\\') inQuotes = !inQuotes;
    else if (!inQuotes && character === '<') angleDepth += 1;
    else if (!inQuotes && character === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if (!inQuotes && angleDepth === 0 && (character === ',' || character === ';')) {
      pushAddress(result, value.slice(start, index));
      start = index + 1;
    }
  }
  pushAddress(result, value.slice(start));
  return result;
}

export function formatEmailAddress(address: EmailAddress): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

export function normalizeReceivedAt(value: string | number | undefined): string {
  const numeric = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  const timestamp = typeof numeric === 'number' ? numeric : Date.parse(numeric ?? '');
  if (!Number.isFinite(timestamp)) throw new TypeError('receivedAt must be a valid date');
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) throw new TypeError('receivedAt must be a valid date');
  return date.toISOString();
}

function pushAddress(result: string[], candidate: string): void {
  const parsed = parseEmailAddress(candidate);
  if (parsed.address) result.push(parsed.address);
}

function normalizeAddress(value: string): string {
  return value.trim().replace(/^mailto:/i, '').toLowerCase();
}
