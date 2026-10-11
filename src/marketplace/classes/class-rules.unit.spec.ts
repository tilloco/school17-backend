import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { CODE_ALPHABET, CODE_LENGTH, firstName, hashSecret, newInviteToken, newJoinCode, normalizeCode, sessionTimes } from './class-rules';

describe('class rules (pure)', () => {
  it('join codes: 8 unambiguous characters, normalisation, hashing', () => {
    for (let i = 0; i < 200; i++) {
      const c = newJoinCode();
      assert.equal(c.length, CODE_LENGTH);
      assert.ok([...c].every((ch) => CODE_ALPHABET.includes(ch)));
      assert.ok(!/[01OIL]/.test(c));
      assert.equal(normalizeCode(c.toLowerCase()), c);
    }
    assert.equal(normalizeCode('abcd-2345'), 'ABCD2345');
    for (const bad of ['', 'ABC', 'ABCD234O', 'ABCD23456', 'ABCD 234!']) assert.equal(normalizeCode(bad), null, bad);
    assert.notEqual(hashSecret('ABCD2345'), 'ABCD2345');
    assert.equal(hashSecret('x'), hashSecret('x'));
    assert.notEqual(newInviteToken(), newInviteToken());
  });
  it('first names only', () => {
    assert.equal(firstName('Ali Valiyev'), 'Ali');
    assert.equal(firstName('  Ali  '), 'Ali');
    assert.equal(firstName(null), '—');
  });
  it('weekly schedule in the teacher time zone, with start/end dates', () => {
    const base = { weekdays: [1, 3], startMinute: 18 * 60, durationMin: 60, timezone: 'Asia/Tashkent', startDate: null, endDate: null, oneOffStartAt: null };
    const t = sessionTimes(base, new Date('2026-11-02T00:00:00Z'), new Date('2026-11-16T00:00:00Z'));
    assert.deepEqual(t.map((d) => d.toISOString()), ['2026-11-02T13:00:00.000Z', '2026-11-04T13:00:00.000Z', '2026-11-09T13:00:00.000Z', '2026-11-11T13:00:00.000Z']);
    const lim = sessionTimes({ ...base, startDate: new Date('2026-11-04T00:00:00Z'), endDate: new Date('2026-11-09T12:00:00Z') }, new Date('2026-11-02T00:00:00Z'), new Date('2026-12-01T00:00:00Z'));
    assert.deepEqual(lim.map((d) => d.toISOString()), ['2026-11-04T13:00:00.000Z', '2026-11-09T13:00:00.000Z']);
  });
  it('one-off class and window edges', () => {
    const at = new Date('2026-11-05T10:00:00Z');
    const one = { weekdays: [], startMinute: 0, durationMin: 60, timezone: 'Asia/Tashkent', startDate: null, endDate: null, oneOffStartAt: at };
    assert.equal(sessionTimes(one, new Date('2026-11-05T10:00:00Z'), new Date('2026-11-06T00:00:00Z')).length, 1);
    assert.equal(sessionTimes(one, new Date('2026-11-05T10:00:01Z'), new Date('2026-11-06T00:00:00Z')).length, 0);
    assert.equal(sessionTimes(one, new Date('2026-11-01T00:00:00Z'), new Date('2026-11-05T10:00:00Z')).length, 0, 'to is exclusive');
  });
});
