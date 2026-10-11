import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';

/**
 * Maxfiy maydonlarni (karta raqami) AES-256-GCM bilan shifrlash. Kalit: APP_DATA_KEY (32 bayt: 64 hex belgi yoki base64).
 * Production'da kalit bo'lmasa funksiya O'CHIQ (available()=false) — hech qachon "ishlayotgandek" ko'rsatilmaydi.
 * Dev/test'da ogohlantirish bilan ishlab chiqish kaliti ishlatiladi (u maxfiylikni ta'minlamaydi).
 * Format: v1.<iv>.<tag>.<ciphertext> (base64url). Eslatma: kalitni almashtirish eski yozuvlarni o'qib bo'lmas qiladi (KNOWN_GAPS).
 */
const log = new Logger('DataCrypto');
let warned = false;

export class CryptoUnavailableError extends Error {
  constructor() {
    super('APP_DATA_KEY is not configured');
  }
}

function parseKey(raw: string): Buffer | null {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const b = Buffer.from(raw, 'base64');
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

function key(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.APP_DATA_KEY;
  if (raw) {
    const k = parseKey(raw);
    if (!k) throw new Error('APP_DATA_KEY must be 32 bytes (64 hex chars or base64)');
    return k;
  }
  if (env.NODE_ENV === 'production') throw new CryptoUnavailableError();
  if (!warned) {
    warned = true;
    log.warn('APP_DATA_KEY is not set: using an INSECURE development key (never use this in production).');
  }
  return createHash('sha256').update('school17-insecure-dev-key').digest();
}

/** Funksiya ishlashga tayyormi (production'da kalit bor-yo'qligi) */
export function cryptoAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    key(env);
    return true;
  } catch (e) {
    if (e instanceof CryptoUnavailableError) return false;
    throw e;
  }
}

export function encryptField(plain: string, env: NodeJS.ProcessEnv = process.env): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(env), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptField(blob: string, env: NodeJS.ProcessEnv = process.env): string {
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Bad ciphertext');
  const d = createDecipheriv('aes-256-gcm', key(env), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
