import { createHash, createHmac, timingSafeEqual } from 'crypto';

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signHs256(payload: Record<string, unknown>, secret: string): string {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** Imzo va muddatni tekshiradi; yaroqsiz bo'lsa null qaytaradi. */
export function verifyHs256(token: string, secret: string, now: Date): Record<string, any> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(parts[2], 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (header.alg !== 'HS256') return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const nowSec = Math.floor(now.getTime() / 1000);
    if (typeof payload.exp === 'number' && nowSec >= payload.exp) return null;
    if (typeof payload.nbf === 'number' && nowSec < payload.nbf) return null;
    return payload;
  } catch {
    return null;
  }
}

export const sha256Base64 = (s: string) => createHash('sha256').update(s).digest('base64');
