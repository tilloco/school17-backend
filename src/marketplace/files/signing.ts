import { createHmac, timingSafeEqual } from 'crypto';

export interface SignedParams {
  /** Nima uchun: 'put' | 'get' */
  op: 'put' | 'get';
  fileId: string;
  /** put: chunk indeksi; get: variant ('original' | 'thumb') */
  part: string;
  /** Imzo faqat shu foydalanuvchi uchun (havola boshqasiga berilsa ishlamaydi) */
  uid: string;
  exp: number; // unix sekund
}

function mac(secret: string, p: SignedParams): string {
  return createHmac('sha256', secret).update(`${p.op}|${p.fileId}|${p.part}|${p.uid}|${p.exp}`).digest('base64url');
}

export function sign(secret: string, p: SignedParams): string {
  return mac(secret, p);
}

export function verifySignature(secret: string, p: SignedParams, sig: string, nowMs: number): boolean {
  if (!Number.isFinite(p.exp) || p.exp * 1000 < nowMs) return false;
  const a = Buffer.from(mac(secret, p));
  const b = Buffer.from(sig ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signedQuery(secret: string, p: SignedParams): string {
  return `uid=${encodeURIComponent(p.uid)}&exp=${p.exp}&sig=${sign(secret, p)}`;
}
