import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { DirectPaymentStatus } from '@prisma/client';
import { DirectEvent, FROM, nextDirectStatus } from './direct-payment-rules';

const STATUSES: DirectPaymentStatus[] = ['UNPAID', 'PUPIL_MARKED_PAID', 'TEACHER_CONFIRMED', 'NOT_RECEIVED', 'WAIVED'];
const EVENTS = Object.keys(FROM) as DirectEvent[];

describe('direct payment state machine (pure)', () => {
  it('documented transitions', () => {
    assert.equal(nextDirectStatus('UNPAID', 'pupil_paid'), 'PUPIL_MARKED_PAID');
    assert.equal(nextDirectStatus('NOT_RECEIVED', 'pupil_paid'), 'PUPIL_MARKED_PAID');
    assert.equal(nextDirectStatus('PUPIL_MARKED_PAID', 'teacher_received'), 'TEACHER_CONFIRMED');
    assert.equal(nextDirectStatus('UNPAID', 'teacher_received'), 'TEACHER_CONFIRMED', 'teacher may confirm cash/other transfers');
    assert.equal(nextDirectStatus('PUPIL_MARKED_PAID', 'teacher_not_received'), 'NOT_RECEIVED');
    assert.equal(nextDirectStatus('UNPAID', 'teacher_waive'), 'WAIVED');
  });
  it('TEACHER_CONFIRMED and WAIVED are terminal for every event', () => {
    for (const e of EVENTS) {
      assert.equal(nextDirectStatus('TEACHER_CONFIRMED', e), null, e);
      assert.equal(nextDirectStatus('WAIVED', e), null, e);
    }
  });
  it('"not received" is only possible after the pupil marked paid; a pupil cannot confirm; nothing leaves the table', () => {
    for (const s of STATUSES) if (s !== 'PUPIL_MARKED_PAID') assert.equal(nextDirectStatus(s, 'teacher_not_received'), null, s);
    for (const e of EVENTS) for (const s of STATUSES) {
      const n = nextDirectStatus(s, e);
      if (n) assert.ok(STATUSES.includes(n));
    }
    assert.equal(EVENTS.length, 5);
  });
});
