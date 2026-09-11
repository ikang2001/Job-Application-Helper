import {
  MAX_JD_LENGTH,
  type JobDescriptionSnapshot,
  type Sha256Digest,
} from './types.ts';

export function normalizeJobDescription(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('当前环境不支持 Web Crypto SHA-256');
  }

  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function createJobDescriptionSnapshot(
  rawText: string,
  sourceUrl: string,
  capturedAt: string,
  digest: Sha256Digest = sha256Hex,
): Promise<JobDescriptionSnapshot | undefined> {
  const normalized = normalizeJobDescription(rawText);
  if (!normalized) {
    return undefined;
  }

  const contentHash = await digest(normalized);
  return {
    text: normalized.slice(0, MAX_JD_LENGTH),
    capturedAt,
    sourceUrl,
    contentHash,
    truncated: normalized.length > MAX_JD_LENGTH,
  };
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };

  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (entity, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
        return String.fromCodePoint(codePoint);
      }
      return entity;
    }
    return namedEntities[body.toLowerCase()] ?? entity;
  });
}
