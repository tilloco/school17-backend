// Sinf qoidalari (sof mantiq): seans vaqtlari, qo'shilish kodi, ism qisqartirish.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { localParts, zonedToUtc } from '../common/time';

/** Chalkashadigan belgilarsiz (0/O, 1/I/L) 31 belgi. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

export function newJoinCode(): string {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}
export function normalizeCode(raw: string): string | null {
  const c = raw.replace(/[\s-]/g, '').toUpperCase();
  return c.length === CODE_LENGTH && [...c].every((ch) => CODE_ALPHABET.includes(ch)) ? c : null;
}
export const hashSecret = (v: string) => createHash('sha256').update(v).digest('hex');
export const newInviteToken = () => randomBytes(18).toString('base64url');

export function firstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] || '—';
}

export interface ScheduleInput {
  weekdays: number[];
  startMinute: number;
  durationMin: number;
  timezone: string;
  startDate: Date | null;
  endDate: Date | null;
  oneOffStartAt: Date | null;
}

/**
 * [from, to) oralig'idagi seans boshlanish vaqtlari (UTC). Bir martalik sinf: faqat oneOffStartAt.
 * Takrorlanish: o'qituvchi vaqt zonasidagi har bir mos hafta kuni; startDate/endDate shu zonadagi kun sifatida (ikkalasi ham kiritilgan kun).
 */
export function sessionTimes(s: ScheduleInput, from: Date, to: Date): Date[] {
  if (s.oneOffStartAt) return s.oneOffStartAt >= from && s.oneOffStartAt < to ? [s.oneOffStartAt] : [];
  const out: Date[] = [];
  const dayMs = 86_400_000;
  const first = localParts(from, s.timezone);
  let cursor = Date.UTC(first.year, first.month - 1, first.day);
  const lim = localParts(to, s.timezone);
  const last = Date.UTC(lim.year, lim.month - 1, lim.day);
  const startKey = s.startDate ? ymdKey(localParts(s.startDate, s.timezone)) : -Infinity;
  const endKey = s.endDate ? ymdKey(localParts(s.endDate, s.timezone)) : Infinity;
  for (; cursor <= last; cursor += dayMs) {
    const d = new Date(cursor);
    const iso = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    if (!s.weekdays.includes(iso)) continue;
    const key = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    if (key < startKey || key > endKey) continue;
    const at = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), s.startMinute, s.timezone);
    if (at >= from && at < to) out.push(at);
  }
  return out;
}
const ymdKey = (p: { year: number; month: number; day: number }) => p.year * 10000 + p.month * 100 + p.day;
