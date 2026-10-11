import { BookingStatus } from '@prisma/client';
import { marketConfig } from '../common/config';

export type BookingEvent = 'accept' | 'decline' | 'expire' | 'cancel' | 'complete' | 'noShowStudent' | 'noShowTeacher' | 'fail';

const TRANSITIONS: Record<BookingStatus, Partial<Record<BookingEvent, BookingStatus>>> = {
  REQUESTED: { accept: 'CONFIRMED', decline: 'DECLINED', expire: 'EXPIRED', cancel: 'CANCELLED' },
  CONFIRMED: { cancel: 'CANCELLED', complete: 'COMPLETED', noShowStudent: 'NO_SHOW_STUDENT', noShowTeacher: 'NO_SHOW_TEACHER', fail: 'FAILED' },
  DECLINED: {},
  EXPIRED: {},
  CANCELLED: {},
  COMPLETED: {},
  NO_SHOW_STUDENT: {},
  NO_SHOW_TEACHER: {},
  FAILED: {},
};

export function nextBookingStatus(s: BookingStatus, e: BookingEvent): BookingStatus | null {
  return TRANSITIONS[s][e] ?? null;
}

/** Faol bronlar vaqtni band qiladi (DB exclusion constraint ham shu ro'yxatga mos). */
export const ACTIVE_STATUSES: BookingStatus[] = ['REQUESTED', 'CONFIRMED'];

/** Butun tiyin, yarim tiyin yuqoriga yaxlitlanadi (musbat sonlar uchun). */
export function priceForDuration(priceMinorPer60: number, durationMin: number): number {
  return Math.round((priceMinorPer60 * durationMin) / 60);
}

export interface JoinWindow {
  opensAt: Date;
  closesAt: Date;
}

export function joinWindow(startAt: Date, endAt: Date, cfg = marketConfig()): JoinWindow {
  return {
    opensAt: new Date(startAt.getTime() - cfg.joinOpensMinutesBefore * 60_000),
    closesAt: new Date(endAt.getTime() + cfg.joinClosesMinutesAfterEnd * 60_000),
  };
}

export function isJoinWindowOpen(startAt: Date, endAt: Date, now: Date, cfg = marketConfig()): boolean {
  const w = joinWindow(startAt, endAt, cfg);
  return now >= w.opensAt && now <= w.closesAt;
}

export type CancelSide = 'STUDENT' | 'TEACHER' | 'SYSTEM';

export interface CancellationOutcome {
  late: boolean;
  /** O'quvchiga qaytariladigan ulush, bazis punkt (10000 = 100%) */
  refundBps: number;
}

/**
 * Bekor qilish qoidasi:
 *  - o'qituvchi bekor qilsa: har doim to'liq qaytarish;
 *  - o'quvchi darsdan >= freeCancelHours oldin: to'liq qaytarish;
 *  - kechroq: lateCancelRefundBps (standart 0%) — NEEDS LAWYER (iste'molchi huquqlari) va mahsulot qarori.
 */
export function cancellationOutcome(side: CancelSide, startAt: Date, now: Date, cfg = marketConfig()): CancellationOutcome {
  if (side !== 'STUDENT') return { late: false, refundBps: 10_000 };
  const hoursLeft = (startAt.getTime() - now.getTime()) / 3_600_000;
  const late = hoursLeft < cfg.freeCancelHours;
  return { late, refundBps: late ? cfg.lateCancelRefundBps : 10_000 };
}

/** Boshlanish vaqti uchun umumiy cheklovlar (slot mavjudligi alohida tekshiriladi). */
export function startTimeProblem(startAt: Date, now: Date, cfg = marketConfig()): string | null {
  if (Number.isNaN(startAt.getTime())) return 'Invalid start time';
  if (startAt.getTime() < now.getTime() + cfg.minNoticeMinutes * 60_000) return 'Too soon';
  if (startAt.getTime() > now.getTime() + cfg.maxAdvanceDays * 86_400_000) return 'Too far ahead';
  if (startAt.getUTCSeconds() !== 0 || startAt.getUTCMilliseconds() !== 0 || startAt.getUTCMinutes() % 15 !== 0) return 'Start must be on a 15-minute boundary';
  return null;
}

/** Yo'qligi (no-show) belgisini qo'yish mumkin bo'lgan eng erta vaqt. */
export function earliestNoShowAt(startAt: Date, cfg = marketConfig()): Date {
  return new Date(startAt.getTime() + cfg.noShowGraceMinutes * 60_000);
}

/** Ism ko'rinishi: voyaga yetmaganlar uchun faqat ism + familiya bosh harfi. */
export function displayName(name: string | null, isMinor: boolean): string {
  const n = (name ?? '').trim();
  if (!n) return '—';
  if (!isMinor) return n;
  const [first, ...rest] = n.split(/\s+/);
  return rest.length ? `${first} ${rest[rest.length - 1][0].toUpperCase()}.` : first;
}
