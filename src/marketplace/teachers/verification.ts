import { VerificationStatus } from '@prisma/client';

export type VerificationEvent = 'submit' | 'approve' | 'reject' | 'suspend' | 'reinstate';

const TRANSITIONS: Record<VerificationStatus, Partial<Record<VerificationEvent, VerificationStatus>>> = {
  DRAFT: { submit: 'PENDING' },
  PENDING: { approve: 'VERIFIED', reject: 'REJECTED' },
  REJECTED: { submit: 'PENDING' },
  VERIFIED: { suspend: 'SUSPENDED' },
  SUSPENDED: { reinstate: 'VERIFIED' },
};

/** Faqat jadvaldagi o'tishlar ruxsat etiladi; "VERIFIED" ga faqat PENDING dan approve orqali kelinadi. */
export function nextStatus(current: VerificationStatus, event: VerificationEvent): VerificationStatus | null {
  return TRANSITIONS[current][event] ?? null;
}

export interface CompletenessInput {
  headline: string;
  bio: string;
  subjects: string[];
  levels: string[];
  languages: string[];
  priceMinor: number;
  availabilityRules: number;
  credentialCount: number;
}

/** Tekshiruvga yuborishdan oldin profil to'liqligi. Bo'sh ro'yxat => to'liq. */
export function missingForSubmission(p: CompletenessInput): string[] {
  const missing: string[] = [];
  if (p.headline.trim().length < 5) missing.push('headline');
  if (p.bio.trim().length < 50) missing.push('bio');
  if (p.subjects.length === 0) missing.push('subjects');
  if (p.levels.length === 0) missing.push('levels');
  if (p.languages.length === 0) missing.push('languages');
  if (p.priceMinor <= 0) missing.push('price');
  if (p.availabilityRules === 0) missing.push('availability');
  if (p.credentialCount === 0) missing.push('credentials');
  return missing;
}

const VIDEO_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'vimeo.com', 'player.vimeo.com']);

/** Tanishtiruv videosi: faqat https va ruxsat etilgan hostlar (ilovaning o'z originida fayl ko'rsatilmaydi). */
export function isAllowedIntroVideoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && VIDEO_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}
