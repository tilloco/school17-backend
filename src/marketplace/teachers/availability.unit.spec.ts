import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { expandRules, generateSlots, parseHHMM, validateRules } from './availability';
import { offsetMinutes, subtractIntervals, zonedToUtc, localParts } from '../common/time';
import { isAllowedIntroVideoUrl, missingForSubmission, nextStatus } from './verification';

describe('time zones', () => {
  it('Asia/Tashkent is UTC+5 with no DST', () => {
    assert.equal(offsetMinutes(new Date('2026-01-15T00:00:00Z'), 'Asia/Tashkent'), 300);
    assert.equal(offsetMinutes(new Date('2026-07-15T00:00:00Z'), 'Asia/Tashkent'), 300);
  });
  it('zonedToUtc converts local wall time', () => {
    assert.equal(zonedToUtc(2026, 3, 10, 9 * 60, 'Asia/Tashkent').toISOString(), '2026-03-10T04:00:00.000Z');
  });
  it('handles DST zone (Europe/Moscow fixed, America/New_York summer/winter)', () => {
    assert.equal(zonedToUtc(2026, 1, 10, 9 * 60, 'America/New_York').toISOString(), '2026-01-10T14:00:00.000Z');
    assert.equal(zonedToUtc(2026, 7, 10, 9 * 60, 'America/New_York').toISOString(), '2026-07-10T13:00:00.000Z');
  });
  it('localParts weekday is ISO', () => {
    assert.equal(localParts(new Date('2026-10-11T12:00:00Z'), 'Asia/Tashkent').isoWeekday, 7); // yakshanba
  });
  it('subtractIntervals splits windows', () => {
    const w = [{ start: new Date(0), end: new Date(100) }];
    const r = subtractIntervals(w, [{ start: new Date(40), end: new Date(60) }]);
    assert.deepEqual(r.map((x) => [x.start.getTime(), x.end.getTime()]), [[0, 40], [60, 100]]);
  });
});

describe('availability rules', () => {
  it('validates granularity, order, overlap', () => {
    assert.throws(() => validateRules([{ weekday: 1, start: '09:10', end: '10:00' }]));
    assert.throws(() => validateRules([{ weekday: 1, start: '10:00', end: '09:00' }]));
    assert.throws(() => validateRules([{ weekday: 8, start: '09:00', end: '10:00' }]));
    assert.throws(() => validateRules([{ weekday: 1, start: '09:00', end: '11:00' }, { weekday: 1, start: '10:45', end: '12:00' }]));
    assert.equal(validateRules([{ weekday: 1, start: '09:00', end: '10:00' }, { weekday: 1, start: '10:00', end: '11:00' }]).length, 2);
    assert.equal(parseHHMM('24:00'), 1440);
    assert.throws(() => parseHHMM('24:30'));
  });

  it('expands weekly rules into UTC windows in the teacher timezone', () => {
    // Dushanba 09:00-11:00 Toshkent = 04:00-06:00Z. 2026-10-12 dushanba.
    const rules = validateRules([{ weekday: 1, start: '09:00', end: '11:00' }]);
    const w = expandRules(rules, 'Asia/Tashkent', new Date('2026-10-12T00:00:00Z'), new Date('2026-10-13T00:00:00Z'));
    assert.deepEqual(w.map((x) => [x.start.toISOString(), x.end.toISOString()]), [['2026-10-12T04:00:00.000Z', '2026-10-12T06:00:00.000Z']]);
  });

  it('generates slots excluding busy and past times, whole slot must fit', () => {
    const rules = validateRules([{ weekday: 1, start: '09:00', end: '11:00' }]);
    const base = { rules, timezone: 'Asia/Tashkent', from: new Date('2026-10-12T00:00:00Z'), to: new Date('2026-10-13T00:00:00Z'), durationMin: 60, notBefore: new Date('2026-10-01T00:00:00Z') };
    const all = generateSlots({ ...base, busy: [] }).map((d) => d.toISOString());
    assert.deepEqual(all, ['2026-10-12T04:00:00.000Z', '2026-10-12T04:30:00.000Z', '2026-10-12T05:00:00.000Z']);
    const busy = generateSlots({ ...base, busy: [{ start: new Date('2026-10-12T04:30:00Z'), end: new Date('2026-10-12T05:30:00Z') }] });
    assert.equal(busy.length, 0); // 04:00-05:00 kesishadi, 05:00-06:00 ham kesishadi
    const past = generateSlots({ ...base, busy: [], notBefore: new Date('2026-10-12T04:45:00Z') }).map((d) => d.toISOString());
    assert.deepEqual(past, ['2026-10-12T05:00:00.000Z']);
  });
});

describe('verification state machine', () => {
  it('VERIFIED only reachable from PENDING via approve', () => {
    for (const s of ['DRAFT', 'REJECTED', 'VERIFIED', 'SUSPENDED'] as const) assert.equal(nextStatus(s, 'approve'), null);
    assert.equal(nextStatus('PENDING', 'approve'), 'VERIFIED');
    assert.equal(nextStatus('DRAFT', 'submit'), 'PENDING');
    assert.equal(nextStatus('REJECTED', 'submit'), 'PENDING');
    assert.equal(nextStatus('VERIFIED', 'submit'), null);
    assert.equal(nextStatus('SUSPENDED', 'reinstate'), 'VERIFIED');
    assert.equal(nextStatus('DRAFT', 'reinstate'), null);
  });
  it('completeness list', () => {
    const full = { headline: 'Math tutor', bio: 'x'.repeat(60), subjects: ['math'], levels: ['adult'], languages: ['uz'], priceMinor: 5_000_000, availabilityRules: 1, credentialCount: 1 };
    assert.deepEqual(missingForSubmission(full), []);
    assert.deepEqual(missingForSubmission({ ...full, credentialCount: 0, bio: 'short' }).sort(), ['bio', 'credentials']);
  });
  it('intro video allowlist: https youtube/vimeo only', () => {
    assert.equal(isAllowedIntroVideoUrl('https://www.youtube.com/watch?v=abc'), true);
    assert.equal(isAllowedIntroVideoUrl('https://youtu.be/abc'), true);
    assert.equal(isAllowedIntroVideoUrl('http://youtu.be/abc'), false);
    assert.equal(isAllowedIntroVideoUrl('https://evil.com/x.mp4'), false);
    assert.equal(isAllowedIntroVideoUrl('https://youtube.com.evil.com/x'), false);
    assert.equal(isAllowedIntroVideoUrl('javascript:alert(1)'), false);
    assert.equal(isAllowedIntroVideoUrl('https://user:pw@youtube.com/x'), false);
  });
});
