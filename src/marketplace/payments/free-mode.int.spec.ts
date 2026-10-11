import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ClockService } from '../common/clock';
import { api, createTestApp, makeAdmin, makeTeacher, makeUser, TestApp } from '../testing/harness';

const NOW = new Date('2026-11-02T00:00:00Z');
const at = (hms: string) => new Date('2026-11-03T' + hms + 'Z');

// ESCROW_ENABLED NOT set: School17 is free; the S8 payment code is dormant.
describe('free mode (ESCROW_ENABLED off)', () => {
  let t: TestApp;
  let clock: ClockService;
  let admin: { id: string; token: string };

  before(async () => {
    delete process.env.ESCROW_ENABLED;
    t = await createTestApp();
    clock = t.app.get(ClockService);
    clock.set(NOW);
    admin = await makeAdmin(t);
  });
  after(async () => {
    delete process.env.PAYMENT_REQUIRED_FOR_CALLS;
    clock.set(null);
    await t.close();
  });

  it('payment, earnings, payout and ledger routes do not exist (404) for everyone, even anonymous', async () => {
    const u = await makeUser(t);
    const id = '11111111-1111-4111-8111-111111111111';
    const routes: [string, string][] = [
      ['POST', `/bookings/${id}/pay`], ['GET', '/payments/mine'], ['POST', `/bookings/${id}/dispute`], ['GET', '/earnings'], ['GET', '/payouts'], ['POST', '/payouts'],
      ['GET', '/admin/market/payments/review'], ['GET', '/admin/market/payouts'], ['GET', '/admin/market/ledger/integrity'], ['GET', '/admin/market/ledger/trial-balance'],
    ];
    for (const [method, path] of routes) {
      for (const token of [undefined, u.token, admin.token]) {
        const res = await fetch(t.baseUrl + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: method === 'POST' ? '{}' : undefined });
        assert.equal(res.status, 404, `${method} ${path} ${token ? 'with token' : 'anonymous'}`);
      }
    }
  });

  it('a full lesson (book -> accept -> call -> complete) creates NO payment or ledger rows and calls never ask for payment', async () => {
    process.env.PAYMENT_REQUIRED_FOR_CALLS = 'true'; // bepul rejimda bu bayroq e'tiborsiz
    const tch = await makeTeacher(t, { approve: { adminToken: admin.token } });
    await api(t, tch.user.token).put('/teachers/me/profile', { instantBooking: true });
    const s = await makeUser(t);
    const b = (await api(t, s.token).post('/bookings', { teacherId: tch.profileId, startAt: '2026-11-03T05:00:00.000Z', durationMin: 60 })).body;
    assert.equal(b.status, 'CONFIRMED');
    clock.set(at('04:58:00'));
    assert.equal((await api(t, s.token).post(`/calls/${b.id}/token`)).status, 200, 'no payment gate');
    assert.equal((await api(t, tch.user.token).post(`/calls/${b.id}/token`)).status, 200);
    await api(t, tch.user.token).post(`/calls/${b.id}/presence`, { event: 'joined' });
    await api(t, s.token).post(`/calls/${b.id}/presence`, { event: 'joined' });
    clock.set(at('05:59:30'));
    await api(t, tch.user.token).post(`/calls/${b.id}/presence`, { event: 'heartbeat' });
    await api(t, s.token).post(`/calls/${b.id}/presence`, { event: 'heartbeat' });
    clock.set(at('06:00:00'));
    await api(t, tch.user.token).post(`/calls/${b.id}/presence`, { event: 'left' });
    const end = await api(t, s.token).post(`/calls/${b.id}/end`);
    assert.equal(end.body.status, 'COMPLETED');
    // bekor qilish, rad etish, muddati o'tish ham pul yozuvini yaratmaydi
    clock.set(NOW);
    const b2 = (await api(t, s.token).post('/bookings', { teacherId: tch.profileId, startAt: '2026-11-04T05:00:00.000Z', durationMin: 60 })).body;
    await api(t, s.token).post(`/bookings/${b2.id}/cancel`);
    assert.equal(await t.prisma.ledgerEntry.count({ where: { bookingId: { in: [b.id, b2.id] } } }), 0);
    assert.equal(await t.prisma.ledgerEntry.count({ where: { ownerId: { in: [s.id, tch.user.id] } } }), 0);
    assert.equal(await t.prisma.lessonPayment.count({ where: { bookingId: { in: [b.id, b2.id] } } }), 0);
  });

  it('the old payment code stays intact: with ESCROW_ENABLED the routes exist again (payments.int.spec.ts covers behaviour)', async () => {
    process.env.ESCROW_ENABLED = 'true';
    try {
      const u = await makeUser(t);
      assert.notEqual((await api(t, u.token).get('/payments/mine')).status, 404);
    } finally {
      delete process.env.ESCROW_ENABLED;
    }
    assert.equal((await api(t).get('/payments/mine')).status, 404);
  });
});
