import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Role } from '@prisma/client';
import { ClockService } from '../common/clock';
import { DomainEvents } from '../common/events';
import { CallsService } from '../calls/calls.service';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makeTeacher, makeUser, TestApp, TestUser } from '../testing/harness';
import { LedgerService } from './ledger.service';
import { PaymentsService } from './payments.service';
import { MockPaymentProvider, PAYMENT_PROVIDER } from './payment-provider';

const NOW = new Date('2026-11-02T00:00:00Z');
const START = '2026-11-03T05:00:00.000Z';
const at = (hms: string) => new Date('2026-11-03T' + hms + 'Z');
const A = 5_000_000; // 60 daqiqalik dars narxi (tiyin)

describe('payments, ledger, earnings (integration, MOCK provider)', () => {
  let t: TestApp;
  let clock: ClockService;
  let admin: { id: string; token: string };
  let ledger: LedgerService;
  let events: DomainEvents;
  let provider: MockPaymentProvider;
  let payments: PaymentsService;
  let day = 0;

  async function lesson(opts: { student?: TestUser; teacher?: Awaited<ReturnType<typeof makeTeacher>>; hour?: number } = {}) {
    const tch = opts.teacher ?? (await makeTeacher(t, { approve: { adminToken: admin.token } }));
    await api(t, tch.user.token).put('/teachers/me/profile', { instantBooking: true });
    const student = opts.student ?? (await makeUser(t));
    clock.set(NOW);
    const days = ['03', '04', '05', '06', '09', '10', '11', '12'];
    const n = day++;
    const startAt = opts.hour != null ? `2026-11-03T${String(opts.hour).padStart(2, '0')}:00:00.000Z` : `2026-11-${days[n % days.length]}T${String(4 + (Math.floor(n / days.length) % 8)).padStart(2, '0')}:00:00.000Z`;
    const b = await api(t, student.token).post('/bookings', { teacherId: tch.profileId, startAt, durationMin: 60 });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    return { tch, student, bookingId: b.body.id as string, startAt };
  }
  const pay = (u: TestUser, bookingId: string, key = 'key-' + randomUUID(), body: object = {}) =>
    fetch(t.baseUrl + `/bookings/${bookingId}/pay`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + u.token, 'idempotency-key': key }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) as any }));
  const payout = (u: TestUser, amountMinor: number, destination = 'Humo ****1234', key = 'po-' + randomUUID()) =>
    fetch(t.baseUrl + '/payouts', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + u.token, 'idempotency-key': key }, body: JSON.stringify({ amountMinor, destination }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) as any }));
  const bal = (account: any, owner: string | null = null) => ledger.balance(account, owner);
  const state = async (bookingId: string) => (await t.prisma.lessonPayment.findUniqueOrThrow({ where: { bookingId } })).state;

  /** Dars yakunlandi deb belgilaydi va hodisani yuboradi (haqiqiy qo'ng'iroq oqimi alohida testda) */
  async function complete(bookingId: string, billableSeconds = 3600) {
    await t.prisma.booking.update({ where: { id: bookingId }, data: { status: 'COMPLETED', completedAt: clock.now(), actualDurationSec: billableSeconds } });
    await events.emit('booking.completed', { bookingId, billableSeconds });
  }

  before(async () => {
    process.env.ESCROW_ENABLED = 'true'; // S8 kodi faqat shu bayroq bilan ishlaydi (bepul rejimda o'chiq)
    t = await createTestApp();
    clock = t.app.get(ClockService);
    clock.set(NOW);
    admin = await makeAdmin(t);
    ledger = t.app.get(LedgerService);
    events = t.app.get(DomainEvents);
    provider = t.app.get(PAYMENT_PROVIDER);
    payments = t.app.get(PaymentsService);
  });
  after(async () => {
    delete process.env.ESCROW_ENABLED;
    clock.set(null);
    await t.close();
  });

  it('route matrix', async () => {
    const actors = { STUDENT: await makeUser(t, Role.STUDENT), GUARDIAN: await makeUser(t, Role.GUARDIAN), TEACHER: await makeUser(t, Role.TEACHER), adminToken: admin.token };
    const id = '11111111-1111-4111-8111-111111111111';
    const failures = await checkRouteMatrix(t, actors, [
      { method: 'GET', path: '/payments/mine', allowed: ['STUDENT', 'GUARDIAN'] },
      { method: 'POST', path: '/bookings/' + id + '/dispute', body: { reason: 'a long enough reason' }, allowed: ['STUDENT', 'GUARDIAN'] },
      { method: 'GET', path: '/earnings', allowed: ['TEACHER'] },
      { method: 'GET', path: '/payouts', allowed: ['TEACHER'] },
      { method: 'POST', path: '/payouts', body: { amountMinor: 10, destination: 'x' }, allowed: ['TEACHER'] },
      { method: 'GET', path: '/admin/market/payments/review', scope: 'admin', allowed: ['ADMIN'] },
      { method: 'GET', path: '/admin/market/payouts', scope: 'admin', allowed: ['ADMIN'] },
      { method: 'GET', path: '/admin/market/ledger/integrity', scope: 'admin', allowed: ['ADMIN'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('paying: money goes to ESCROW; idempotent per key; second key = ALREADY_PAID; only the booker can pay', async () => {
    const x = await lesson();
    const escrow0 = await bal('ESCROW');
    const key = 'pay-' + randomUUID();
    const r1 = await pay(x.student, x.bookingId, key);
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.state, 'PAID');
    assert.equal(r1.body.amountMinor, A);
    assert.equal(await bal('ESCROW'), escrow0 + A);
    const r2 = await pay(x.student, x.bookingId, key);
    assert.equal(r2.status, 200);
    assert.equal(r2.body.id, r1.body.id);
    assert.equal(await bal('ESCROW'), escrow0 + A, 'no double charge');
    assert.equal(await t.prisma.ledgerEntry.count({ where: { paymentId: r1.body.id } }), 2);
    const again = await pay(x.student, x.bookingId);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'ALREADY_PAID');
    assert.equal((await pay(x.tch.user, x.bookingId)).status, 403, 'teachers have no payment.pay');
    assert.equal((await pay(await makeUser(t), x.bookingId)).status, 404, 'IDOR');
    assert.equal((await api(t, x.student.token).post(`/bookings/${x.bookingId}/pay`, {})).status, 400, 'Idempotency-Key required');
    assert.equal((await pay(x.student, x.bookingId, 'short')).status, 400);
  });

  it('concurrent identical requests charge once', async () => {
    const x = await lesson();
    const key = 'race-' + randomUUID();
    const before = provider.charges.size;
    const rs = await Promise.all(Array.from({ length: 6 }, () => pay(x.student, x.bookingId, key)));
    assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.map((r) => r.status)));
    assert.equal(provider.charges.size, before + 1);
    assert.equal(await t.prisma.ledgerEntry.count({ where: { bookingId: x.bookingId, kind: 'PAYMENT_RECEIVED' } }), 2);
    // ikki xil kalit bir vaqtda: bittasi yutadi, ikkinchisi to'lovga olib kelmaydi
    const y = await lesson();
    const [a, b] = await Promise.all([pay(y.student, y.bookingId, 'k-a-' + randomUUID()), pay(y.student, y.bookingId, 'k-b-' + randomUUID())]);
    assert.ok([a.status, b.status].includes(200));
    assert.equal(await t.prisma.ledgerEntry.count({ where: { bookingId: y.bookingId, kind: 'PAYMENT_RECEIVED' } }), 2);
  });

  it('card numbers are refused; declined payments leave no money trace and can be retried', async () => {
    const x = await lesson();
    assert.equal((await pay(x.student, x.bookingId, undefined, { paymentMethod: '8600 1234 5678 9012' })).status, 400);
    const escrow0 = await bal('ESCROW');
    const declined = await pay(x.student, x.bookingId, undefined, { paymentMethod: 'tok_decline' });
    assert.equal(declined.status, 402);
    assert.equal(declined.body.code, 'PAYMENT_FAILED');
    assert.equal(await bal('ESCROW'), escrow0);
    assert.equal(await state(x.bookingId), 'FAILED');
    const ok = await pay(x.student, x.bookingId, undefined, { paymentMethod: 'tok_ok' });
    assert.equal(ok.status, 200);
    assert.equal(await bal('ESCROW'), escrow0 + A);
  });

  it('completed lesson: escrow -> teacher PENDING (hold) -> after the hold: commission to platform, rest AVAILABLE', async () => {
    const x = await lesson();
    await pay(x.student, x.bookingId);
    const tid = x.tch.user.id;
    const escrow0 = await bal('ESCROW');
    const rev0 = await bal('PLATFORM_REVENUE');
    await complete(x.bookingId);
    assert.equal(await state(x.bookingId), 'ON_HOLD');
    assert.equal(await bal('ESCROW'), escrow0 - A);
    assert.equal(await bal('TEACHER_PENDING', tid), A);
    assert.equal(await bal('TEACHER_AVAILABLE', tid), 0, 'not withdrawable during the hold');
    await complete(x.bookingId); // takroriy hodisa: hech narsa o'zgarmaydi
    assert.equal(await bal('TEACHER_PENDING', tid), A);
    // hold tugamagan: sweep hech narsa qilmaydi
    clock.set(new Date(NOW.getTime() + 3 * 3_600_000));
    await payments.releaseDue();
    assert.equal(await state(x.bookingId), 'ON_HOLD');
    // 24 soatdan keyin
    clock.set(new Date(NOW.getTime() + 25 * 3_600_000));
    await payments.releaseDue();
    assert.equal(await state(x.bookingId), 'RELEASED');
    assert.equal(await bal('TEACHER_PENDING', tid), 0);
    assert.equal(await bal('TEACHER_AVAILABLE', tid), A - 750_000);
    const pid = (await t.prisma.lessonPayment.findUniqueOrThrow({ where: { bookingId: x.bookingId } })).id;
    const revRows = await t.prisma.ledgerEntry.findMany({ where: { account: 'PLATFORM_REVENUE', paymentId: pid } });
    assert.deepEqual(revRows.map((r) => Number(r.amountMinor)), [750_000]);
    assert.ok((await bal('PLATFORM_REVENUE')) >= rev0 + 750_000);
    await payments.releaseDue();
    assert.equal(await bal('TEACHER_AVAILABLE', tid), A - 750_000, 'release is idempotent');
    const dash = (await api(t, x.tch.user.token).get('/earnings')).body;
    assert.equal(dash.balances.availableMinor, A - 750_000);
    assert.equal(dash.balances.pendingMinor, 0);
    assert.equal(dash.lessons[0].grossMinor, A);
    assert.equal(dash.lessons[0].commissionMinor, 750_000);
    assert.equal(dash.lessons[0].netMinor, A - 750_000);
    assert.equal(dash.commissionBps, 1500);
  });

  it('a short lesson is paid proportionally and the rest goes back to the payer; < 90% threshold logic', async () => {
    const x = await lesson();
    await pay(x.student, x.bookingId);
    await complete(x.bookingId, 1800); // 30 daqiqa / 60
    const p = await t.prisma.lessonPayment.findUniqueOrThrow({ where: { bookingId: x.bookingId } });
    assert.equal(p.earnedMinor, A / 2);
    assert.equal(p.refundedMinor, A / 2);
    assert.equal(await bal('TEACHER_PENDING', x.tch.user.id), A / 2);
    assert.ok(provider.refunds.size > 0, 'provider refund was requested');
    const y = await lesson();
    await pay(y.student, y.bookingId);
    await complete(y.bookingId, 3300); // 55 daqiqa => 91.7% => to'liq
    assert.equal((await t.prisma.lessonPayment.findUniqueOrThrow({ where: { bookingId: y.bookingId } })).earnedMinor, A);
  });

  it('cancellation refunds: early student, teacher (even late) => full; late student => policy (default 0%), configurable', async () => {
    const early = await lesson();
    await pay(early.student, early.bookingId);
    const e0 = await bal('ESCROW');
    await api(t, early.student.token).post(`/bookings/${early.bookingId}/cancel`);
    assert.equal(await state(early.bookingId), 'REFUNDED');
    assert.equal(await bal('ESCROW'), e0 - A);

    const tchCancel = await lesson();
    await pay(tchCancel.student, tchCancel.bookingId);
    clock.set(new Date(tchCancel.startAt) /* dars boshlanishidan 1 daqiqa oldin */);
    clock.set(new Date(new Date(tchCancel.startAt).getTime() - 60_000));
    await api(t, tchCancel.tch.user.token).post(`/bookings/${tchCancel.bookingId}/cancel`);
    assert.equal(await state(tchCancel.bookingId), 'REFUNDED');

    const late = await lesson();
    await pay(late.student, late.bookingId);
    clock.set(new Date(new Date(late.startAt).getTime() - 2 * 3_600_000));
    await api(t, late.student.token).post(`/bookings/${late.bookingId}/cancel`);
    const lp = await t.prisma.lessonPayment.findUniqueOrThrow({ where: { bookingId: late.bookingId } });
    assert.equal(lp.state, 'ON_HOLD');
    assert.equal(lp.earnedMinor, A, 'late cancel => teacher keeps the fee (default policy)');
    assert.equal(lp.refundedMinor, 0);

    process.env.BOOKING_LATE_CANCEL_REFUND_BPS = '5000';
    try {
      const half = await lesson();
      await pay(half.student, half.bookingId);
      clock.set(new Date(new Date(half.startAt).getTime() - 2 * 3_600_000));
      await api(t, half.student.token).post(`/bookings/${half.bookingId}/cancel`);
      const hp = await t.prisma.lessonPayment.findUniqueOrThrow({ where: { bookingId: half.bookingId } });
      assert.equal(hp.earnedMinor, A / 2);
      assert.equal(hp.refundedMinor, A / 2);
    } finally {
      delete process.env.BOOKING_LATE_CANCEL_REFUND_BPS;
    }
    clock.set(NOW);
  });

  it('declined and expired requests refund automatically', async () => {
    const tch = await makeTeacher(t, { approve: { adminToken: admin.token } }); // so'rov rejimi (instant emas)
    const s1 = await makeUser(t);
    const b1 = await api(t, s1.token).post('/bookings', { teacherId: tch.profileId, startAt: '2026-11-04T06:00:00.000Z', durationMin: 60 });
    assert.equal(b1.body.status, 'REQUESTED');
    await pay(s1, b1.body.id);
    const e0 = await bal('ESCROW');
    await api(t, tch.user.token).post(`/bookings/${b1.body.id}/decline`, { reason: 'busy' });
    assert.equal(await state(b1.body.id), 'REFUNDED');
    assert.equal(await bal('ESCROW'), e0 - A);

    const s2 = await makeUser(t);
    const b2 = await api(t, s2.token).post('/bookings', { teacherId: tch.profileId, startAt: '2026-11-05T06:00:00.000Z', durationMin: 60 });
    await pay(s2, b2.body.id);
    clock.set(new Date(NOW.getTime() + 25 * 3_600_000));
    await api(t, s2.token).get('/bookings/' + b2.body.id); // o'qish muddati o'tganlarni EXPIRED qiladi
    assert.equal(await state(b2.body.id), 'REFUNDED');
    clock.set(NOW);
  });

  it('no-shows: student no-show pays the teacher; teacher no-show refunds; technical failure waits for a human', async () => {
    const a = await lesson();
    await pay(a.student, a.bookingId);
    await events.emit('booking.noshow', { bookingId: a.bookingId, kind: 'NO_SHOW_STUDENT' });
    assert.equal(await state(a.bookingId), 'ON_HOLD');
    assert.equal(await bal('TEACHER_PENDING', a.tch.user.id), A);

    const b = await lesson();
    await pay(b.student, b.bookingId);
    await events.emit('booking.noshow', { bookingId: b.bookingId, kind: 'NO_SHOW_TEACHER' });
    assert.equal(await state(b.bookingId), 'REFUNDED');
    assert.equal(await bal('TEACHER_PENDING', b.tch.user.id), 0);

    const c = await lesson();
    await pay(c.student, c.bookingId);
    const e0 = await bal('ESCROW');
    await events.emit('booking.failed', { bookingId: c.bookingId, note: 'insufficient_overlap' });
    assert.equal(await state(c.bookingId), 'UNDER_REVIEW');
    assert.equal(await bal('ESCROW'), e0, 'money stays in escrow until a human decides');
    const q = (await api(t, admin.token).get('/admin/market/payments/review')).body;
    const item = q.find((i: any) => i.bookingId === c.bookingId);
    assert.ok(item);
    // admin: 40% qaytarish, qolgani o'qituvchiga
    const pid = (await t.prisma.lessonPayment.findUniqueOrThrow({ where: { bookingId: c.bookingId } })).id;
    assert.equal((await api(t, c.student.token).post(`/admin/market/payments/${pid}/resolve`, { outcome: 'REFUND', note: 'x' })).status, 401);
    assert.equal((await api(t, admin.token).post(`/admin/market/payments/${pid}/resolve`, { outcome: 'REFUND', refundMinor: A + 1, note: 'too much' })).status, 400);
    const res = await api(t, admin.token).post(`/admin/market/payments/${pid}/resolve`, { outcome: 'REFUND', refundMinor: 2_000_000, note: 'partial' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await bal('ESCROW'), e0 - A);
    const cp = await t.prisma.lessonPayment.findUniqueOrThrow({ where: { id: pid } });
    assert.equal(cp.refundedMinor, 2_000_000);
    assert.equal(cp.earnedMinor, 3_000_000);
    assert.equal(cp.state, 'RELEASED', 'remaining part is released immediately after a resolution');
    assert.equal(await bal('TEACHER_AVAILABLE', c.tch.user.id), 3_000_000 - 450_000);
    assert.equal((await api(t, admin.token).post(`/admin/market/payments/${pid}/resolve`, { outcome: 'RELEASE', note: 'again' })).status, 409);
  });

  it('dispute: only the payer, only during the hold; freezes the release; admin can refund (partial) or release', async () => {
    const x = await lesson();
    await pay(x.student, x.bookingId);
    await complete(x.bookingId);
    const tid = x.tch.user.id;
    assert.equal((await api(t, (await makeUser(t)).token).post(`/bookings/${x.bookingId}/dispute`, { reason: 'long enough reason' })).status, 404);
    assert.equal((await api(t, x.student.token).post(`/bookings/${x.bookingId}/dispute`, { reason: 'short' })).status, 400);
    const d = await api(t, x.student.token).post(`/bookings/${x.bookingId}/dispute`, { reason: 'The teacher did not teach the agreed topic' });
    assert.equal(d.status, 200);
    assert.equal(d.body.state, 'DISPUTED');
    clock.set(new Date(NOW.getTime() + 30 * 3_600_000));
    await payments.releaseDue();
    assert.equal(await state(x.bookingId), 'DISPUTED', 'frozen');
    assert.equal(await bal('TEACHER_AVAILABLE', tid), 0);
    const pid = (await t.prisma.lessonPayment.findUniqueOrThrow({ where: { bookingId: x.bookingId } })).id;
    await api(t, admin.token).post(`/admin/market/payments/${pid}/resolve`, { outcome: 'REFUND', refundMinor: 1_000_000, note: 'partial refund' });
    const p = await t.prisma.lessonPayment.findUniqueOrThrow({ where: { id: pid } });
    assert.equal(p.state, 'RELEASED');
    assert.equal(p.earnedMinor, 4_000_000);
    assert.equal(await bal('TEACHER_AVAILABLE', tid), 4_000_000 - 600_000);

    // dispute oynasi yopilgach ochib bo'lmaydi
    clock.set(NOW);
    const y = await lesson();
    await pay(y.student, y.bookingId);
    await complete(y.bookingId);
    clock.set(new Date(NOW.getTime() + 26 * 3_600_000));
    const late = await api(t, y.student.token).post(`/bookings/${y.bookingId}/dispute`, { reason: 'too late to complain really' });
    assert.equal(late.status, 409);
    assert.equal(late.body.code, 'DISPUTE_WINDOW_CLOSED');

    // RELEASE
    clock.set(NOW);
    const z = await lesson();
    await pay(z.student, z.bookingId);
    await complete(z.bookingId);
    await api(t, z.student.token).post(`/bookings/${z.bookingId}/dispute`, { reason: 'not satisfied with the lesson' });
    const zid = (await t.prisma.lessonPayment.findUniqueOrThrow({ where: { bookingId: z.bookingId } })).id;
    await api(t, admin.token).post(`/admin/market/payments/${zid}/resolve`, { outcome: 'RELEASE', note: 'teacher was right' });
    assert.equal(await bal('TEACHER_AVAILABLE', z.tch.user.id), A - 750_000);
  });

  it('payouts: min amount, balance check, idempotency, no card numbers, race-safe, admin pay/reject, provider failure', async () => {
    process.env.MIN_PAYOUT_MINOR = '1000000';
    const tch = await makeTeacher(t, { approve: { adminToken: admin.token } });
    await api(t, tch.user.token).put('/teachers/me/profile', { instantBooking: true });
    // 2 ta dars: 2 x (5,000,000 - 750,000) = 8,500,000 mavjud
    for (let i = 0; i < 2; i++) {
      const x = await lesson({ teacher: tch });
      await pay(x.student, x.bookingId);
      await complete(x.bookingId);
    }
    clock.set(new Date(NOW.getTime() + 25 * 3_600_000));
    await payments.releaseDue();
    const tid = tch.user.id;
    assert.equal(await bal('TEACHER_AVAILABLE', tid), 8_500_000);

    assert.equal((await payout(tch.user, 1_000)).status, 400, 'below minimum');
    assert.equal((await payout(tch.user, 9_000_000)).status, 409, 'above balance');
    assert.equal((await payout(tch.user, 6_000_000, '8600 1234 5678 9012')).status, 400, 'card number');
    assert.equal((await api(t, tch.user.token).post('/payouts', { amountMinor: 6_000_000, destination: 'Humo ****1234' })).status, 400, 'Idempotency-Key required');
    assert.equal((await payout((await makeUser(t)), 6_000_000)).status, 403, 'students cannot request payouts');

    // poyga: ikkita 5 mln so'rov, mavjud 8.5 mln => faqat bittasi o'tadi
    const [r1, r2] = await Promise.all([payout(tch.user, 5_000_000), payout(tch.user, 5_000_000)]);
    assert.deepEqual([r1.status, r2.status].sort(), [201, 409]);
    assert.equal(await bal('TEACHER_AVAILABLE', tid), 3_500_000);
    assert.equal(await bal('PAYOUT_PENDING', tid), 5_000_000);

    const key = 'po-idem-' + randomUUID();
    const a = await payout(tch.user, 3_000_000, 'Humo ****1234', key);
    const b = await payout(tch.user, 3_000_000, 'Humo ****1234', key);
    assert.equal(a.body.id, b.body.id);
    assert.equal((await payout(tch.user, 3_100_000, 'Humo ****1234', key)).status, 409, 'same key, different amount');
    assert.equal(await bal('TEACHER_AVAILABLE', tid), 500_000, 'idempotent request debited once');

    // boshqa o'qituvchi bu so'rovlarni ko'rmaydi/boshqara olmaydi
    const other = await makeTeacher(t);
    assert.deepEqual((await api(t, other.user.token).get('/payouts')).body, []);
    assert.equal((await api(t, other.user.token).post(`/admin/market/payouts/${a.body.id}/pay`)).status, 401);

    // admin to'laydi
    const paid = await api(t, admin.token).post(`/admin/market/payouts/${r1.status === 201 ? r1.body.id : r2.body.id}/pay`);
    assert.equal(paid.status, 200);
    assert.equal(paid.body.status, 'PAID');
    assert.equal(await bal('PAYOUT_PENDING', tid), 3_000_000);
    assert.equal(await bal('EXTERNAL_PAYOUTS', tid), 5_000_000);
    assert.equal((await api(t, admin.token).post(`/admin/market/payouts/${paid.body.id}/pay`)).status, 409, 'cannot pay twice');
    assert.equal((await api(t, admin.token).post(`/admin/market/payouts/${paid.body.id}/reject`, { reason: 'x' })).status, 409);

    // rad etish: pul qaytadi
    const rej = await api(t, admin.token).post(`/admin/market/payouts/${a.body.id}/reject`, { reason: 'Invalid destination' });
    assert.equal(rej.body.status, 'REJECTED');
    assert.equal(await bal('TEACHER_AVAILABLE', tid), 3_500_000);
    assert.equal(await bal('PAYOUT_PENDING', tid), 0);

    // provayder xatosi: pul "kutilmoqda"da qoladi, holat REQUESTED
    const bad = await payout(tch.user, 3_000_000, 'fail-card');
    assert.equal(bad.status, 201);
    const failed = await api(t, admin.token).post(`/admin/market/payouts/${bad.body.id}/pay`);
    assert.equal(failed.status, 502);
    assert.equal((await t.prisma.payoutRequest.findUniqueOrThrow({ where: { id: bad.body.id } })).status, 'REQUESTED');
    assert.equal(await bal('PAYOUT_PENDING', tid), 3_000_000);
    const dash = (await api(t, tch.user.token).get('/earnings')).body;
    assert.equal(dash.balances.paidOutMinor, 5_000_000);
    assert.equal(dash.balances.payoutPendingMinor, 3_000_000);
    clock.set(NOW);
    delete process.env.MIN_PAYOUT_MINOR;
  });

  it('ledger integrity: every transaction balances, whole ledger sums to zero, rows are immutable', async () => {
    const integrity = (await api(t, admin.token).get('/admin/market/ledger/integrity')).body;
    assert.equal(integrity.ok, true, JSON.stringify(integrity));
    assert.deepEqual(integrity.unbalancedTxns, []);
    assert.equal(integrity.total, 0);
    const tb = (await api(t, admin.token).get('/admin/market/ledger/trial-balance')).body;
    assert.equal(Object.values(tb as Record<string, number>).reduce((n, v) => n + v, 0), 0);
    for (const acct of ['ESCROW', 'TEACHER_PENDING', 'TEACHER_AVAILABLE', 'PAYOUT_PENDING', 'PLATFORM_REVENUE']) assert.ok(tb[acct] >= 0, acct);
    // o'zgartirib/o'chirib bo'lmaydi
    const row = await t.prisma.ledgerEntry.findFirstOrThrow();
    await assert.rejects(t.prisma.ledgerEntry.update({ where: { id: row.id }, data: { amountMinor: 1n } }), /append-only/);
    await assert.rejects(t.prisma.ledgerEntry.delete({ where: { id: row.id } }), /append-only/);
    // nomutanosib yozuv rad etiladi, takror kalit e'tiborsiz
    await assert.rejects(t.prisma.$transaction((tx) => ledger.post(tx, { key: 'bad-' + randomUUID(), kind: 'T', lines: [{ account: 'ESCROW', amount: 10 }, { account: 'EXTERNAL_PAYMENTS', amount: -9 }] })), /Unbalanced/);
    const key = 'dup-' + randomUUID();
    const ownerId = randomUUID();
    const post = () => t.prisma.$transaction((tx) => ledger.post(tx, { key, kind: 'T', lines: [{ account: 'EXTERNAL_PAYMENTS', ownerId, amount: -10 }, { account: 'ESCROW', amount: 10 }] }));
    assert.equal(await post(), true);
    assert.equal(await post(), false);
    // manfiy qoldiq taqiqlangan
    await assert.rejects(t.prisma.$transaction((tx) => ledger.post(tx, { key: 'neg-' + randomUUID(), kind: 'T', lines: [{ account: 'TEACHER_AVAILABLE', ownerId: randomUUID(), amount: -5 }, { account: 'EXTERNAL_PAYOUTS', amount: 5 }] })), /Insufficient/);
    // tuzatish ham yangi yozuv: ESCROW ni qaytaramiz
    await t.prisma.$transaction((tx) => ledger.post(tx, { key: 'undo-' + randomUUID(), kind: 'T', lines: [{ account: 'ESCROW', amount: -10 }, { account: 'EXTERNAL_PAYMENTS', ownerId, amount: 10 }] }));
    assert.equal((await ledger.verifyIntegrity()).ok, true);
  });

  it('a teacher sees only their own earnings; payers see only their own payments', async () => {
    const x = await lesson();
    await pay(x.student, x.bookingId);
    await complete(x.bookingId);
    const other = await makeTeacher(t);
    const otherDash = (await api(t, other.user.token).get('/earnings')).body;
    assert.equal(otherDash.balances.pendingMinor, 0);
    assert.deepEqual(otherDash.lessons, []);
    const mine = (await api(t, x.student.token).get('/payments/mine')).body;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].bookingId, x.bookingId);
    assert.deepEqual((await api(t, (await makeUser(t)).token).get('/payments/mine')).body, []);
    const raw = JSON.stringify(mine);
    assert.ok(!raw.includes(x.tch.user.id), 'payer cannot see teacher user id');
  });

  it('REAL flow: payment -> call -> automatic settlement with the measured duration', async () => {
    const x = await lesson({ hour: 5 });
    await pay(x.student, x.bookingId);
    const calls = t.app.get(CallsService);
    clock.set(at('04:58:00'));
    await api(t, x.tch.user.token).post(`/calls/${x.bookingId}/token`);
    await api(t, x.student.token).post(`/calls/${x.bookingId}/token`);
    await api(t, x.tch.user.token).post(`/calls/${x.bookingId}/presence`, { event: 'joined' });
    clock.set(at('05:15:00'));
    await api(t, x.student.token).post(`/calls/${x.bookingId}/presence`, { event: 'joined' }); // 15 daqiqa kechikdi
    clock.set(at('05:59:30'));
    await api(t, x.tch.user.token).post(`/calls/${x.bookingId}/presence`, { event: 'heartbeat' });
    await api(t, x.student.token).post(`/calls/${x.bookingId}/presence`, { event: 'heartbeat' });
    clock.set(at('06:00:00'));
    await api(t, x.tch.user.token).post(`/calls/${x.bookingId}/presence`, { event: 'left' });
    await api(t, x.student.token).post(`/calls/${x.bookingId}/end`);
    assert.ok(calls);
    const p = await t.prisma.lessonPayment.findUniqueOrThrow({ where: { bookingId: x.bookingId } });
    assert.equal(p.state, 'ON_HOLD');
    assert.equal(p.earnedMinor, Math.floor((A * 2700) / 3600), '45 of 60 minutes together => 75%');
    assert.equal(p.refundedMinor, A - p.earnedMinor);
  });

  it('PAYMENT_REQUIRED_FOR_CALLS gates call tokens; unpaid => 402, paid => 200', async () => {
    process.env.PAYMENT_REQUIRED_FOR_CALLS = 'true';
    try {
      const x = await lesson({ hour: 6 });
      clock.set(at('05:58:00'));
      const no = await api(t, x.student.token).post(`/calls/${x.bookingId}/token`);
      assert.equal(no.status, 402);
      assert.equal(no.body.code, 'PAYMENT_REQUIRED');
      clock.set(NOW);
      await pay(x.student, x.bookingId);
      clock.set(at('05:58:00'));
      assert.equal((await api(t, x.student.token).post(`/calls/${x.bookingId}/token`)).status, 200);
    } finally {
      delete process.env.PAYMENT_REQUIRED_FOR_CALLS;
      clock.set(NOW);
    }
  });

  it('with the mock provider in production, payment routes are disabled (503), never "pretend" to take money', async () => {
    const x = await lesson();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const r = await pay(x.student, x.bookingId);
      assert.equal(r.status, 503);
      assert.equal(r.body.code, 'PAYMENTS_NOT_CONFIGURED');
      assert.equal((await payout(x.tch.user, 6_000_000)).status, 503);
    } finally {
      process.env.NODE_ENV = prev;
    }
    assert.equal(await t.prisma.lessonPayment.count({ where: { bookingId: x.bookingId } }), 0);
  });
});
