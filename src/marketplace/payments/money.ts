// Pul hisob-kitobi: FAQAT butun sonlar (tiyin). Float ishlatilmaydi. Barcha funksiyalar sof va xavfsiz-butun sonni tekshiradi.

export function assertMoney(n: number, name = 'amount'): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return n;
}

/** floor(a * num / den) — oraliq ko'paytma xavfsiz oraliqdan chiqsa xato (BigInt bilan aniq hisoblanadi). */
export function mulDivFloor(a: number, num: number, den: number): number {
  assertMoney(a);
  assertMoney(num);
  if (!Number.isSafeInteger(den) || den <= 0) throw new Error('den must be positive');
  const r = (BigInt(a) * BigInt(num)) / BigInt(den);
  return Number(r);
}

/** Yarimi yuqoriga yaxlitlangan: round(a * num / den). */
export function mulDivRound(a: number, num: number, den: number): number {
  assertMoney(a);
  assertMoney(num);
  const r = (BigInt(a) * BigInt(num) * 2n + BigInt(den)) / (BigInt(den) * 2n);
  return Number(r);
}

/** Komissiya (bazis punkt: 1500 = 15%). Yaxlitlash: yarimi yuqoriga. Natija 0..earned. */
export function commissionFor(earnedMinor: number, bps: number): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error('bps out of range');
  return Math.min(earnedMinor, mulDivRound(earnedMinor, bps, 10_000));
}

export interface Split {
  commission: number;
  teacherNet: number;
}

export function splitEarned(earnedMinor: number, bps: number): Split {
  const commission = commissionFor(earnedMinor, bps);
  return { commission, teacherNet: earnedMinor - commission };
}

/**
 * Dars davomiyligi bo'yicha to'lanadigan ulush. Rejadagi vaqtning >= 90% i o'tgan bo'lsa — to'liq,
 * aks holda proporsional (butun tiyinga pastga yaxlitlanadi). NEEDS LAWYER/mahsulot qarori.
 */
export const FULL_PAY_THRESHOLD_PCT = 90;

export function earnedForDuration(amountMinor: number, billableSeconds: number, scheduledSeconds: number): number {
  assertMoney(amountMinor);
  assertMoney(billableSeconds, 'billableSeconds');
  if (!Number.isSafeInteger(scheduledSeconds) || scheduledSeconds <= 0) throw new Error('scheduledSeconds must be positive');
  const billable = Math.min(billableSeconds, scheduledSeconds);
  if (billable * 100 >= scheduledSeconds * FULL_PAY_THRESHOLD_PCT) return amountMinor;
  return mulDivFloor(amountMinor, billable, scheduledSeconds);
}

/** Qaytariladigan summa (bps) — yuqoriga emas, pastga yaxlitlanadi (platforma foydasiga emas, o'qituvchi foydasiga qoldiq). */
export function refundForBps(amountMinor: number, refundBps: number): number {
  if (!Number.isInteger(refundBps) || refundBps < 0 || refundBps > 10_000) throw new Error('refundBps out of range');
  return mulDivFloor(amountMinor, refundBps, 10_000);
}

/** To'lov usuli matnida karta raqami (PAN) bo'lmasligi uchun: 13-19 raqam ketma-ket (bo'shliq/chiziqcha bilan) bo'lsa rad. */
export function looksLikeCardNumber(s: string): boolean {
  return /\d{13,19}/.test(s.replace(/[\s-]/g, ''));
}
