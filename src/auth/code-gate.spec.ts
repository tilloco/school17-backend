import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { GateState, GateResult, gateStep, HOUR } from './code-gate';

const at = (h: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, 0) + h * HOUR);
const must = (r: GateResult): GateState => { assert.equal(r.ok, true); return (r as { ok: true; next: GateState }).next; };
const wait = (r: GateResult): number => { assert.equal(r.ok, false); return (r as { ok: false; retryAfterMs: number }).retryAfterMs / HOUR; };

describe('sign-in code requests: 2 in 2 hours, then 2 hours off, then 1 per hour', () => {
  it('the first request is free, the second (the "other number") is allowed, the third waits two full hours', () => {
    const s1 = must(gateStep(null, at(0)));
    const s2 = must(gateStep(s1, at(0.1)));
    assert.ok(Math.abs(wait(gateStep(s2, at(0.2))) - 1.9) < 1e-9, 'locked until two hours after the SECOND request (asked at 0.1h, now 0.2h)');
    assert.ok(wait(gateStep(s2, at(1.9))) > 0.19);
    assert.ok(wait(gateStep(s2, at(2.0))) > 0, 'still locked at exactly 2h after the first (the lock counts from the second)');
  });

  it('after the lock only one request per hour is allowed (for the next 24 hours)', () => {
    let s = must(gateStep(null, at(0)));
    s = must(gateStep(s, at(0.5))); // second -> locked until 2.5h
    assert.ok(wait(gateStep(s, at(2.4))) > 0);
    s = must(gateStep(s, at(2.6))); // first request after the lock
    assert.ok(Math.abs(wait(gateStep(s, at(3.0))) - 0.6) < 1e-9, 'only 1 per hour');
    assert.ok(Math.abs(wait(gateStep(s, at(3.5))) - 0.1) < 1e-9);
    s = must(gateStep(s, at(3.7)));
    assert.ok(wait(gateStep(s, at(4.0))) > 0.6, 'the hour starts again from the last request');
    s = must(gateStep(s, at(4.8)));
  });

  it('after 24 hours without trouble the normal rule is back', () => {
    let s = must(gateStep(null, at(0)));
    s = must(gateStep(s, at(0.5)));
    s = must(gateStep(s, at(2.6)));
    const later = at(2.5 + 24 + 0.1);
    const fresh = must(gateStep(s, later));
    assert.equal(fresh.count, 1);
    const second = must(gateStep(fresh, new Date(later.getTime() + 60_000)));
    assert.ok(second.blockedUntil, 'the second request in the new window locks again');
  });

  it('a request after the first window has passed starts a new window', () => {
    const s1 = must(gateStep(null, at(0)));
    const s2 = must(gateStep(s1, at(2.5)));
    assert.equal(s2.count, 1);
    assert.equal(s2.blockedUntil, null);
  });
});
