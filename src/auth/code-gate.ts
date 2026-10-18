/**
 * How often one person may ask for a sign-in code (every request counts, also to a number that has no Telegram):
 *  - at most 2 requests in 2 hours (for example a wrong number, then the right one);
 *  - after the 2nd request: nothing for 2 hours;
 *  - after that wait, and for the next 24 hours: only 1 request per hour;
 *  - after 24 quiet hours the first rule applies again.
 * Pure on purpose: the same rule is tested with fixed times.
 */
export const HOUR = 3_600_000;
export const GATE = { windowMs: 2 * HOUR, maxInWindow: 2, lockMs: 2 * HOUR, strictMs: 24 * HOUR, strictEveryMs: HOUR } as const;

export interface GateState {
  windowStart: Date;
  count: number;
  lastAt: Date;
  blockedUntil: Date | null;
  strictUntil: Date | null;
}
export type GateResult = { ok: true; next: GateState } | { ok: false; retryAfterMs: number };

export function gateStep(s: GateState | null, now: Date): GateResult {
  const t = now.getTime();
  if (s?.blockedUntil && s.blockedUntil.getTime() > t) return { ok: false, retryAfterMs: s.blockedUntil.getTime() - t };
  if (s?.strictUntil && s.strictUntil.getTime() > t) {
    const since = t - s.lastAt.getTime();
    if (since < GATE.strictEveryMs) return { ok: false, retryAfterMs: GATE.strictEveryMs - since };
    return { ok: true, next: { ...s, lastAt: now, blockedUntil: null } };
  }
  if (!s || s.count === 0 || t - s.windowStart.getTime() >= GATE.windowMs) {
    return { ok: true, next: { windowStart: now, count: 1, lastAt: now, blockedUntil: null, strictUntil: null } };
  }
  const count = s.count + 1;
  if (count >= GATE.maxInWindow) {
    const blockedUntil = new Date(t + GATE.lockMs);
    return { ok: true, next: { windowStart: s.windowStart, count, lastAt: now, blockedUntil, strictUntil: new Date(blockedUntil.getTime() + GATE.strictMs) } };
  }
  return { ok: true, next: { windowStart: s.windowStart, count, lastAt: now, blockedUntil: null, strictUntil: null } };
}
