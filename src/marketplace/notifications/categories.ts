import { localParts, zonedToUtc } from '../common/time';

/**
 * Bildirishnoma turlari -> toifa, ustuvorlik va yashash muddati (TTL). Hamma tur shu yerda sanalgan (test: har bir shablon turi shu jadvalda bo'lishi shart).
 * - toifa: foydalanuvchi shu bo'yicha push'ni o'chira oladi ("account" - o'chirib bo'lmaydi: xavfsizlik)
 * - ustuvorlik: "urgent" tinch soatlarda ham darhol yuboriladi (dars boshlandi, 30 daqiqa qoldi, dars bekor), "low" - sokin
 * - ttl: shu vaqtdan keyin eskirgan push telefonga yetkazilmaydi (masalan "dars boshlandi" 10 daqiqadan keyin foydasiz)
 */
export const CATEGORIES = ['messages', 'lessons', 'reminders', 'classes', 'homework', 'payments', 'account'] as const;
export type Category = (typeof CATEGORIES)[number];
export type Priority = 'urgent' | 'normal' | 'low';

export interface TypeRule {
  category: Category;
  priority: Priority;
  ttlSeconds: number;
}

const H = 3600;
const D = 24 * H;
const r = (category: Category, priority: Priority, ttlSeconds: number): TypeRule => ({ category, priority, ttlSeconds });

export const TYPE_RULES: Record<string, TypeRule> = {
  'message.new': r('messages', 'normal', 2 * D),
  'booking.requested': r('lessons', 'normal', 2 * D),
  'booking.confirmed': r('lessons', 'normal', 2 * D),
  'booking.declined': r('lessons', 'normal', 2 * D),
  'booking.cancelled': r('lessons', 'urgent', D),
  'booking.expired': r('lessons', 'low', D),
  'booking.reschedule_proposed': r('lessons', 'normal', 2 * D),
  'booking.counter_offer': r('lessons', 'normal', 2 * D),
  'review.new': r('lessons', 'low', 7 * D),
  'review.reply': r('lessons', 'low', 7 * D),
  'booking.reminder': r('reminders', 'urgent', 30 * 60),
  'class.reminder_day': r('reminders', 'normal', 6 * H),
  'class.reminder_soon': r('reminders', 'urgent', 15 * 60),
  'class.live': r('classes', 'urgent', 10 * 60),
  'class.teacher_noshow': r('classes', 'normal', D),
  'class.cancelled': r('classes', 'urgent', D),
  'class.session_cancelled': r('classes', 'urgent', D),
  'class.session_added': r('classes', 'normal', 2 * D),
  'class.removed': r('classes', 'normal', 2 * D),
  'class.request': r('classes', 'normal', 2 * D),
  'class.approved': r('classes', 'normal', 2 * D),
  'class.declined': r('classes', 'normal', 2 * D),
  'class.helper': r('classes', 'normal', 2 * D),
  'class.homework': r('homework', 'normal', 3 * D),
  'class.homework_marked': r('homework', 'normal', 3 * D),
  'directpay.marked': r('payments', 'normal', 2 * D),
  'directpay.confirmed': r('payments', 'normal', 2 * D),
  'directpay.not_received': r('payments', 'normal', 2 * D),
  'directpay.waived': r('payments', 'low', 2 * D),
  'directpay.reminder': r('payments', 'low', 2 * D),
  'classpay.reminder': r('payments', 'low', 2 * D),
  'payment.received': r('payments', 'normal', 2 * D),
  'payment.on_hold': r('payments', 'low', 2 * D),
  'payment.released': r('payments', 'low', 2 * D),
  'payment.refunded': r('payments', 'normal', 2 * D),
  'payment.disputed': r('payments', 'normal', 2 * D),
  'payment.resolved': r('payments', 'normal', 2 * D),
  'payout.paid': r('payments', 'normal', 2 * D),
  'payout.rejected': r('payments', 'normal', 2 * D),
  'guardian.linked': r('account', 'urgent', 7 * D),
  'push.test': r('account', 'normal', 10 * 60),
};

const FALLBACK: TypeRule = r('account', 'normal', D);
export const ruleFor = (type: string): TypeRule => TYPE_RULES[type] ?? FALLBACK;
export const isDisableable = (c: Category) => c !== 'account';

export const parseHm = (s: string): number | null => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
export const formatHm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * Tinch soatlar (foydalanuvchining vaqt zonasida; yarim tunni kesib o'tishi mumkin, masalan 22:00-07:00).
 * `now` tinch oraliqda bo'lsa, oraliq tugaydigan paytni (UTC) qaytaradi, aks holda null.
 */
export function quietUntil(now: Date, tz: string, startMin: number | null, endMin: number | null): Date | null {
  if (startMin === null || endMin === null || startMin === endMin) return null;
  const p = localParts(now, tz);
  const m = p.hour * 60 + p.minute;
  const inside = startMin < endMin ? m >= startMin && m < endMin : m >= startMin || m < endMin;
  if (!inside) return null;
  const nextDay = startMin > endMin && m >= startMin ? 1 : 0;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + nextDay));
  return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), endMin, tz);
}
