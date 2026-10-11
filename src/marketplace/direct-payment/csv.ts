// CSV eksport yordamchilari (sof mantiq).

/**
 * Formula inyeksiyasidan himoya: =, +, -, @ yoki tab/CR bilan boshlanadigan katak elektron jadvalda formula sifatida bajarilishi mumkin.
 * Oldiga apostrof qo'shiladi, so'ng RFC 4180 bo'yicha qo'shtirnoqqa olinadi.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** "YYYY-MM" -> [boshi, keyingi oy boshi) UTC, berilgan vaqt zonasida. */
import { zonedToUtc } from '../common/time';
export function monthRange(month: string, tz: string): { from: Date; to: Date } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const from = zonedToUtc(y, mo, 1, 0, tz);
  const to = mo === 12 ? zonedToUtc(y + 1, 1, 1, 0, tz) : zonedToUtc(y, mo + 1, 1, 0, tz);
  return { from, to };
}
