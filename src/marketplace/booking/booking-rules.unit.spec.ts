import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { cancellationOutcome, displayName, isJoinWindowOpen, joinWindow, nextBookingStatus, priceForDuration, startTimeProblem } from './booking-rules';

const cfg = {
  minPriceMinor: 0, maxPriceMinor: 0, lessonDurationsMin: [60], minNoticeMinutes: 60, maxAdvanceDays: 60, requestExpiryHours: 24,
  freeCancelHours: 12, lateCancelRefundBps: 0, joinOpensMinutesBefore: 5, joinClosesMinutesAfterEnd: 5, callTokenTtlSeconds: 600,
  noShowGraceMinutes: 10, commissionBps: 1500,
};

describe('booking rules (pure)', () => {
  it('state machine only allows documented transitions', () => {
    assert.equal(nextBookingStatus('REQUESTED', 'accept'), 'CONFIRMED');
    assert.equal(nextBookingStatus('CONFIRMED', 'accept'), null);
    assert.equal(nextBookingStatus('CANCELLED', 'cancel'), null);
    assert.equal(nextBookingStatus('COMPLETED', 'cancel'), null);
    assert.equal(nextBookingStatus('REQUESTED', 'complete'), null);
    assert.equal(nextBookingStatus('CONFIRMED', 'noShowStudent'), 'NO_SHOW_STUDENT');
    assert.equal(nextBookingStatus('NO_SHOW_TEACHER', 'noShowStudent'), null);
  });

  it('price is proportional, integer', () => {
    assert.equal(priceForDuration(5_000_000, 30), 2_500_000);
    assert.equal(priceForDuration(5_000_000, 45), 3_750_000);
    assert.equal(priceForDuration(3_333_333, 45), 2_500_000); // yaxlitlash
    assert.ok(Number.isInteger(priceForDuration(1_234_567, 90)));
  });

  it('cancellation outcome', () => {
    const start = new Date('2026-11-03T05:00:00Z');
    assert.deepEqual(cancellationOutcome('STUDENT', start, new Date('2026-11-02T00:00:00Z'), cfg), { late: false, refundBps: 10000 });
    assert.deepEqual(cancellationOutcome('STUDENT', start, new Date('2026-11-02T20:00:00Z'), cfg), { late: true, refundBps: 0 });
    assert.deepEqual(cancellationOutcome('STUDENT', start, new Date('2026-11-02T17:00:00Z'), cfg), { late: false, refundBps: 10000 }); // aynan 12 soat
    assert.deepEqual(cancellationOutcome('TEACHER', start, new Date('2026-11-03T04:59:00Z'), cfg), { late: false, refundBps: 10000 });
  });

  it('join window boundaries are inclusive', () => {
    const s = new Date('2026-11-03T05:00:00Z');
    const e = new Date('2026-11-03T06:00:00Z');
    const w = joinWindow(s, e, cfg);
    assert.equal(w.opensAt.toISOString(), '2026-11-03T04:55:00.000Z');
    assert.equal(w.closesAt.toISOString(), '2026-11-03T06:05:00.000Z');
    assert.equal(isJoinWindowOpen(s, e, new Date('2026-11-03T04:54:59Z'), cfg), false);
    assert.equal(isJoinWindowOpen(s, e, new Date('2026-11-03T04:55:00Z'), cfg), true);
    assert.equal(isJoinWindowOpen(s, e, new Date('2026-11-03T06:05:00Z'), cfg), true);
    assert.equal(isJoinWindowOpen(s, e, new Date('2026-11-03T06:05:01Z'), cfg), false);
  });

  it('start time problems', () => {
    const now = new Date('2026-11-02T00:00:00Z');
    assert.equal(startTimeProblem(new Date('2026-11-02T00:30:00Z'), now, cfg), 'Too soon');
    assert.equal(startTimeProblem(new Date('2027-03-01T00:00:00Z'), now, cfg), 'Too far ahead');
    assert.ok(startTimeProblem(new Date('2026-11-03T00:10:00Z'), now, cfg));
    assert.equal(startTimeProblem(new Date('2026-11-03T00:15:00Z'), now, cfg), null);
    assert.ok(startTimeProblem(new Date('nope'), now, cfg));
  });

  it('displayName shortens minors only', () => {
    assert.equal(displayName('Aziz Karimov', true), 'Aziz K.');
    assert.equal(displayName('Aziz', true), 'Aziz');
    assert.equal(displayName('Aziz Karimov', false), 'Aziz Karimov');
    assert.equal(displayName(null, true), '—');
  });
});
