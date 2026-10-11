// Vaqt zonasi yordamchilari (tashqi kutubxonasiz, faqat Intl). Barcha vaqtlar bazada UTC.

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  /** ISO hafta kuni: 1=Dushanba ... 7=Yakshanba */
  isoWeekday: number;
}

export function localParts(date: Date, tz: string): LocalParts {
  const p: Record<string, number> = {};
  for (const part of fmt(tz).formatToParts(date)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const hour = p.hour === 24 ? 0 : p.hour;
  const utcDay = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); // 0=Yak
  return { year: p.year, month: p.month, day: p.day, hour, minute: p.minute, isoWeekday: utcDay === 0 ? 7 : utcDay };
}

/** tz dagi mahalliy vaqt UTC dan necha daqiqa oldinda (UTC+5 => 300). */
export function offsetMinutes(date: Date, tz: string): number {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  const base = Math.floor(date.getTime() / 60000) * 60000;
  return Math.round((asUtc - base) / 60000);
}

/** Mahalliy devor vaqtini (tz) UTC Date ga aylantiradi. DST bo'shlig'ida keyingi haqiqiy vaqtga suradi. */
export function zonedToUtc(year: number, month: number, day: number, minuteOfDay: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, 0, minuteOfDay, 0);
  const off1 = offsetMinutes(new Date(guess), tz);
  let utc = guess - off1 * 60000;
  const off2 = offsetMinutes(new Date(utc), tz);
  if (off2 !== off1) utc = guess - off2 * 60000;
  return new Date(utc);
}

export interface Interval {
  start: Date;
  end: Date;
}

/** a dan b dagi band oraliqlarni ayiradi. Kirish tartiblangan bo'lishi shart emas. */
export function subtractIntervals(windows: Interval[], busy: Interval[]): Interval[] {
  let result = windows.map((w) => ({ ...w }));
  for (const b of busy) {
    const next: Interval[] = [];
    for (const w of result) {
      if (b.end <= w.start || b.start >= w.end) {
        next.push(w);
        continue;
      }
      if (b.start > w.start) next.push({ start: w.start, end: b.start });
      if (b.end < w.end) next.push({ start: b.end, end: w.end });
    }
    result = next;
  }
  return result.sort((x, y) => x.start.getTime() - y.start.getTime());
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}
