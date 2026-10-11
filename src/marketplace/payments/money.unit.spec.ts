import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { commissionFor, earnedForDuration, looksLikeCardNumber, mulDivFloor, mulDivRound, refundForBps, splitEarned } from './money';
import { MockPaymentProvider, createPaymentProvider } from './payment-provider';

// Deterministik psevdo-tasodifiy generator (testlar takrorlanadigan bo'lishi uchun)
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('money (integer minor units)', () => {
  it('commission: known values, half-up rounding', () => {
    assert.equal(commissionFor(5_000_000, 1500), 750_000);
    assert.equal(commissionFor(3, 1500), 0); // 0.45 -> 0
    assert.equal(commissionFor(4, 1500), 1); // 0.6 -> 1
    assert.equal(commissionFor(10, 5000), 5);
    assert.equal(commissionFor(1, 5000), 1); // 0.5 -> yarimi yuqoriga
    assert.equal(commissionFor(1_000, 0), 0);
    assert.equal(commissionFor(1_000, 10_000), 1_000);
  });
  it('property: commission + teacher net always equals earned; never negative; never above earned', () => {
    const r = rng(42);
    for (let i = 0; i < 20_000; i++) {
      const earned = Math.floor(r() * 200_000_000);
      const bps = Math.floor(r() * 10_001);
      const s = splitEarned(earned, bps);
      assert.equal(s.commission + s.teacherNet, earned);
      assert.ok(s.commission >= 0 && s.teacherNet >= 0 && Number.isInteger(s.commission));
    }
  });
  it('property: earned for duration is monotonic, <= amount, full above the 90% threshold', () => {
    const r = rng(7);
    for (let i = 0; i < 5_000; i++) {
      const amount = 1 + Math.floor(r() * 100_000_000);
      const scheduled = 1800 + Math.floor(r() * 5400);
      let prev = -1;
      for (let b = 0; b <= scheduled + 600; b += Math.max(1, Math.floor(scheduled / 40))) {
        const e = earnedForDuration(amount, b, scheduled);
        assert.ok(e >= prev && e <= amount && Number.isInteger(e));
        prev = e;
      }
      assert.equal(earnedForDuration(amount, Math.ceil(scheduled * 0.9), scheduled), amount);
      assert.equal(earnedForDuration(amount, scheduled + 1000, scheduled), amount, 'overtime is not charged extra');
      assert.equal(earnedForDuration(amount, 0, scheduled), 0);
    }
    assert.equal(earnedForDuration(5_000_000, 1800, 3600), 2_500_000);
    assert.equal(earnedForDuration(5_000_000, 3239, 3600), 4_498_611, '89.97% -> proportional, floored');
    assert.equal(earnedForDuration(5_000_000, 3240, 3600), 5_000_000);
  });
  it('refund by bps rounds down; refund + retained = amount', () => {
    assert.equal(refundForBps(5_000_001, 5000), 2_500_000);
    for (const bps of [0, 1, 3333, 5000, 9999, 10_000]) {
      const a = 7_777_777;
      assert.equal(refundForBps(a, bps) + (a - refundForBps(a, bps)), a);
    }
    assert.throws(() => refundForBps(100, 10_001));
  });
  it('rejects floats, negatives and unsafe integers', () => {
    assert.throws(() => mulDivFloor(1.5, 1, 2));
    assert.throws(() => mulDivFloor(-1, 1, 2));
    assert.throws(() => commissionFor(100.5, 1500));
    assert.throws(() => commissionFor(100, 15.5));
    assert.throws(() => earnedForDuration(100, 10, 0));
    assert.throws(() => mulDivFloor(Number.MAX_SAFE_INTEGER + 2, 1, 1));
  });
  it('large values stay exact (BigInt intermediate)', () => {
    assert.equal(mulDivFloor(9_000_000_000_000, 9_999, 10_000), 8_999_100_000_000);
    assert.equal(mulDivRound(9_007_199_254_740_000, 1, 2), 4_503_599_627_370_000);
  });
  it('card number detector catches PAN-like strings but allows masked labels', () => {
    for (const bad of ['8600 1234 5678 9012', '8600-1234-5678-9012', '8600123456789012', 'card 9860 1234 5678 9012 12']) assert.equal(looksLikeCardNumber(bad), true, bad);
    for (const ok of ['Humo ****1234', 'Uzcard •••• 9012', 'Hamyon', 'tok_abc123']) assert.equal(looksLikeCardNumber(ok), false, ok);
  });
});

describe('MockPaymentProvider', () => {
  it('is idempotent per key and refuses key reuse with a different amount', async () => {
    const p = new MockPaymentProvider();
    const a = await p.charge({ amountMinor: 1000, currency: 'UZS', idempotencyKey: 'k1', payerRef: 'u', description: 'x' });
    const b = await p.charge({ amountMinor: 1000, currency: 'UZS', idempotencyKey: 'k1', payerRef: 'u', description: 'x' });
    assert.deepEqual(a, b);
    assert.equal(p.charges.size, 1);
    await assert.rejects(p.charge({ amountMinor: 2000, currency: 'UZS', idempotencyKey: 'k1', payerRef: 'u', description: 'x' }));
    assert.equal((await p.charge({ amountMinor: 1, currency: 'UZS', idempotencyKey: 'k2', payerRef: 'decline-me', description: 'x' })).status, 'FAILED');
    const r1 = await p.refund({ providerRef: a.providerRef, amountMinor: 500, idempotencyKey: 'r1' });
    const r2 = await p.refund({ providerRef: a.providerRef, amountMinor: 500, idempotencyKey: 'r1' });
    assert.equal(r1.providerRef, r2.providerRef);
    assert.equal(p.refunds.size, 1);
  });
  it('only "mock" exists; anything else is refused', () => {
    assert.equal(createPaymentProvider({} as any).name, 'mock');
    assert.throws(() => createPaymentProvider({ PAYMENT_PROVIDER: 'click' } as any), /not implemented/);
    assert.throws(() => createPaymentProvider({ PAYMENT_PROVIDER: 'stripe' } as any), /not implemented/);
  });
});
