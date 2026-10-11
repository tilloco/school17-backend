import { Interval, localParts, subtractIntervals, zonedToUtc } from '../common/time';

export interface RuleInput {
  weekday: number; // 1..7 (ISO)
  start: string; // "HH:MM" mahalliy
  end: string;
}

export interface RuleMinutes {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

export const GRANULARITY_MIN = 15;
export const MAX_RULES = 70;

export class AvailabilityError extends Error {}

export function parseHHMM(s: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) throw new AvailabilityError(`Invalid time "${s}"`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) throw new AvailabilityError(`Invalid time "${s}"`);
  return h * 60 + mi;
}

export function formatHHMM(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** Qoidalarni tekshiradi: 15 daqiqalik qadam, start<end, bir kunda kesishmaslik. */
export function validateRules(rules: RuleInput[]): RuleMinutes[] {
  if (rules.length > MAX_RULES) throw new AvailabilityError('Too many rules');
  const out: RuleMinutes[] = rules.map((r) => {
    if (!Number.isInteger(r.weekday) || r.weekday < 1 || r.weekday > 7) throw new AvailabilityError('Invalid weekday');
    const startMinute = parseHHMM(r.start);
    const endMinute = parseHHMM(r.end);
    if (startMinute >= endMinute) throw new AvailabilityError('Start must be before end');
    if (startMinute % GRANULARITY_MIN || endMinute % GRANULARITY_MIN) throw new AvailabilityError('Times must be multiples of 15 minutes');
    return { weekday: r.weekday, startMinute, endMinute };
  });
  out.sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
  for (let i = 1; i < out.length; i++) {
    if (out[i].weekday === out[i - 1].weekday && out[i].startMinute < out[i - 1].endMinute) {
      throw new AvailabilityError('Overlapping rules');
    }
  }
  return out;
}

/** Haftalik qoidalarni [from, to) oralig'idagi aniq UTC oraliqlarga aylantiradi (o'qituvchi vaqt zonasi bilan). */
export function expandRules(rules: RuleMinutes[], tz: string, from: Date, to: Date): Interval[] {
  const out: Interval[] = [];
  // Mahalliy sanalar bo'yicha yuramiz: from dan 1 kun oldin, to dan 1 kun keyin (zona siljishi uchun)
  const startDay = localParts(new Date(from.getTime() - 86_400_000), tz);
  let cursor = Date.UTC(startDay.year, startDay.month - 1, startDay.day);
  const endMs = to.getTime() + 2 * 86_400_000;
  while (cursor < endMs) {
    const d = new Date(cursor);
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth() + 1;
    const da = d.getUTCDate();
    const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    for (const r of rules) {
      if (r.weekday !== dow) continue;
      const s = zonedToUtc(y, mo, da, r.startMinute, tz);
      const e = r.endMinute === 1440 ? zonedToUtc(y, mo, da + 1, 0, tz) : zonedToUtc(y, mo, da, r.endMinute, tz);
      const cs = s < from ? from : s;
      const ce = e > to ? to : e;
      if (cs < ce) out.push({ start: cs, end: ce });
    }
    cursor += 86_400_000;
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export interface SlotQuery {
  rules: RuleMinutes[];
  timezone: string;
  from: Date;
  to: Date;
  durationMin: number;
  /** Band qilingan (bron qilingan/dam olish) oraliqlar */
  busy: Interval[];
  /** Hozirdan oldin boshlanadigan slotlar chiqmaydi */
  notBefore: Date;
  stepMin?: number;
}

/** Bo'sh slot boshlanish vaqtlari (UTC). Slot to'liq bo'sh oraliqqa sig'ishi shart. */
export function generateSlots(q: SlotQuery): Date[] {
  const step = (q.stepMin ?? 30) * 60_000;
  const dur = q.durationMin * 60_000;
  const from = q.from < q.notBefore ? q.notBefore : q.from;
  const windows = subtractIntervals(expandRules(q.rules, q.timezone, q.from, q.to), q.busy);
  const slots: Date[] = [];
  for (const w of windows) {
    // Slotlarni oraliq boshidan qadam bo'yicha tekislaymiz (ruleslar 15 daqiqalik chegarada boshlanadi)
    let t = w.start.getTime();
    // from dan oldingi slotlarni tashlab o'tamiz, tekislikni saqlagan holda
    if (t < from.getTime()) t += Math.ceil((from.getTime() - t) / step) * step;
    for (; t + dur <= w.end.getTime(); t += step) slots.push(new Date(t));
  }
  return slots;
}
