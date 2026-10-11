import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { ClockService } from '../common/clock';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makeTeacher, makeUser, TestApp, TestUser } from '../testing/harness';
import { ClassRoomService } from './class-room.service';
import { periodOf } from './class-payments.service';

const START = '2026-11-05T10:00:00.000Z';
const at = (m: number) => new Date(new Date(START).getTime() + m * 60_000);
const PRICE = 10_000_000; // 100 000 so'm

describe('class payments: marks only (R7, integration)', () => {
  let t: TestApp;
  let clock: ClockService;
  let admin: { id: string; token: string };

  async function klass(opts: { n?: number; model?: 'PER_SESSION' | 'MONTHLY'; oneOff?: boolean; require?: boolean; price?: number; trial?: boolean } = {}) {
    clock.set(new Date('2026-11-02T00:00:00Z'));
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const body: any = { title: 'Math', subject: 'Math', capacity: 30, priceMinor: opts.price ?? PRICE, priceModel: opts.model ?? 'MONTHLY', requirePaidToJoin: !!opts.require, firstSessionTrial: !!opts.trial };
    if (opts.oneOff) body.oneOffStartAt = START;
    else Object.assign(body, { weekdays: [1, 3], startMinute: 18 * 60, durationMin: 60 });
    const c = (await api(t, x.user.token).post('/classes', body)).body;
    assert.ok(c.id, JSON.stringify(c));
    const ps: TestUser[] = [];
    for (let i = 0; i < (opts.n ?? 2); i++) {
      const u = await makeUser(t, Role.STUDENT, { name: `Pupil${i} Family${i}` });
      assert.equal((await api(t, u.token).post('/classes/join', { code: c.joinCode })).status, 200);
      ps.push(u);
    }
    const sessions = (await api(t, x.user.token).get(`/classes/${c.id}/sessions`)).body as { id: string }[];
    return { x, c, ps, sessions };
  }
  const board = async (x: TestUser, classId: string, period = '') => (await api(t, x.token).get(`/classes/${classId}/money${period ? `?period=${period}` : ''}`)).body;

  before(async () => {
    t = await createTestApp();
    clock = t.app.get(ClockService);
    admin = await makeAdmin(t);
  });
  after(async () => {
    clock.set(null);
    await t.close();
  });

  it('route matrix', async () => {
    const actors = { STUDENT: await makeUser(t, Role.STUDENT), GUARDIAN: await makeUser(t, Role.GUARDIAN), TEACHER: (await makeTeacher(t, { approve: { adminToken: admin.token } })).user, adminToken: admin.token };
    const id = '11111111-1111-4111-8111-111111111111';
    const failures = await checkRouteMatrix(t, actors, [
      { method: 'GET', path: `/classes/${id}/money`, allowed: ['TEACHER'] },
      { method: 'POST', path: `/classes/${id}/money/mark`, body: { action: 'received', paymentIds: [id] }, allowed: ['TEACHER'] },
      { method: 'POST', path: `/classes/${id}/money/remind`, body: {}, allowed: ['TEACHER'] },
      { method: 'GET', path: `/classes/${id}/money/export.csv`, allowed: ['TEACHER'] },
      { method: 'POST', path: `/classes/${id}/money/override`, body: { sessionId: id, pupilId: id }, allowed: ['TEACHER'] },
      { method: 'GET', path: '/teachers/me/money/class-owed', allowed: ['TEACHER'] },
      { method: 'GET', path: '/class-payments/mine', allowed: ['STUDENT', 'GUARDIAN'] },
      { method: 'POST', path: `/class-payments/${id}/paid`, allowed: ['STUDENT', 'GUARDIAN'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('period helper: monthly by the class time zone, per-session by session id', () => {
    const c = { priceModel: 'MONTHLY' as const, timezone: 'Asia/Tashkent' };
    assert.equal(periodOf(c, { id: 's', startAt: new Date('2026-11-30T20:00:00Z') }).key, 'M:2026-12', '01:00 on 1 December in Tashkent');
    assert.equal(periodOf(c, { id: 's', startAt: new Date('2026-11-30T18:00:00Z') }).key, 'M:2026-11');
    assert.deepEqual(periodOf({ priceModel: 'PER_SESSION', timezone: 'UTC' }, { id: 'abc', startAt: new Date() }), { key: 'S:abc', sessionId: 'abc' });
  });

  it('monthly class: one row per pupil, the board shows the period status; the free trial session creates no row', async () => {
    const { x, c, ps } = await klass({ n: 2 });
    const b = await board(x.user, c.id);
    assert.equal(b.period, 'M:2026-11');
    assert.equal(b.rows.length, 2);
    assert.ok(b.rows.every((r: any) => r.status === 'UNPAID' && r.amountMinor === PRICE));
    assert.deepEqual(b.rows.map((r: any) => r.name), ['Pupil0 Family0', 'Pupil1 Family1']);
    assert.equal(b.periods[0].key, 'M:2026-11');
    assert.equal(await t.prisma.classPayment.count({ where: { classId: c.id } }), 2, 'ensure is idempotent');
    // faqat bepul sinov seansi: qator yo'q
    const tr = await klass({ n: 1, oneOff: true, trial: true });
    assert.equal((await board(tr.x.user, tr.c.id)).rows.length, 0);
    assert.deepEqual((await api(t, tr.ps[0].token).get('/class-payments/mine')).body, []);
    // narxsiz sinf
    const free = await klass({ n: 1, price: 0 });
    assert.equal((await board(free.x.user, free.c.id)).rows.length, 0);
    assert.ok(ps.length === 2);
  });

  it('per-session class: a row per session; period switch; strangers cannot read the board', async () => {
    const { x, c, sessions } = await klass({ n: 1, model: 'PER_SESSION' });
    const b = await board(x.user, c.id);
    assert.equal(b.period, `S:${sessions[0].id}`);
    assert.equal(b.rows.length, 1);
    const other = await board(x.user, c.id, `S:${sessions[1].id}`);
    assert.equal(other.rows.length, 1);
    assert.equal((await api(t, x.user.token).get(`/classes/${c.id}/money?period=bogus`)).status, 400);
    const stranger = await makeTeacher(t, { approve: { adminToken: admin.token } });
    assert.equal((await api(t, stranger.user.token).get(`/classes/${c.id}/money`)).status, 404);
    assert.equal((await api(t, (await makeUser(t)).token).get(`/classes/${c.id}/money`)).status, 403);
  });

  it('marks: pupil (or guardian) marks paid; teacher confirms in bulk; wrong states, foreign ids and oversize batches are refused', async () => {
    const { x, c, ps } = await klass({ n: 3 });
    const b = await board(x.user, c.id);
    const pay = (u: TestUser) => b.rows.find((r: any) => r.pupilId === u.id);
    const mine = (await api(t, ps[0].token).get('/class-payments/mine')).body;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].teacher.name !== undefined, true);
    assert.ok(!JSON.stringify(mine).includes(x.user.email));
    assert.equal((await api(t, ps[0].token).post(`/class-payments/${pay(ps[1]).id}/paid`)).status, 404, "someone else's payment");
    const p1 = await api(t, ps[0].token).post(`/class-payments/${pay(ps[0]).id}/paid`);
    assert.equal(p1.status, 200, JSON.stringify(p1.body));
    assert.equal(p1.body.status, 'PUPIL_MARKED_PAID');
    assert.equal((await api(t, ps[0].token).post(`/class-payments/${pay(ps[0]).id}/paid`)).body.code, 'BAD_STATE', 'double mark');
    assert.equal((await api(t, x.user.token).post(`/class-payments/${pay(ps[2]).id}/paid`)).status, 403, 'the teacher cannot mark on behalf of a pupil');
    // o'qituvchi: ommaviy tasdiq
    const bulk = await api(t, x.user.token).post(`/classes/${c.id}/money/mark`, { action: 'received', paymentIds: [pay(ps[0]).id, pay(ps[1]).id] });
    assert.deepEqual(bulk.body, { changed: 2, skipped: 0 });
    assert.equal((await board(x.user, c.id)).rows.filter((r: any) => r.status === 'TEACHER_CONFIRMED').length, 2);
    const again = await api(t, x.user.token).post(`/classes/${c.id}/money/mark`, { action: 'not_received', paymentIds: [pay(ps[0]).id] });
    assert.deepEqual(again.body, { changed: 0, skipped: 1 }, 'confirmed payments are not flipped to not-received');
    assert.equal((await api(t, x.user.token).post(`/classes/${c.id}/money/mark`, { action: 'waive', paymentIds: [pay(ps[2]).id] })).body.changed, 1);
    // begona/yo'q id: butun partiya rad etiladi, hech narsa o'zgarmaydi
    const o = await klass({ n: 1 });
    const foreign = (await board(o.x.user, o.c.id)).rows[0].id;
    const mixed = await api(t, x.user.token).post(`/classes/${c.id}/money/mark`, { action: 'received', paymentIds: [pay(ps[2]).id, foreign] });
    assert.equal(mixed.status, 404);
    assert.equal((await t.prisma.classPayment.findUniqueOrThrow({ where: { id: foreign } })).status, 'UNPAID');
    assert.equal((await api(t, o.x.user.token).post(`/classes/${c.id}/money/mark`, { action: 'received', paymentIds: [pay(ps[2]).id] })).status, 404, 'another teacher');
    assert.equal((await api(t, x.user.token).post(`/classes/${c.id}/money/mark`, { action: 'received', paymentIds: Array.from({ length: 101 }, () => foreign) })).status, 400);
    assert.equal((await api(t, x.user.token).post(`/classes/${c.id}/money/mark`, { action: 'received', paymentIds: [] })).status, 400);
    assert.equal((await api(t, ps[0].token).post(`/classes/${c.id}/money/mark`, { action: 'received', paymentIds: [pay(ps[2]).id] })).status, 403);
  });

  it('guardian marks for a minor; the teacher board shows names; money is only ever marks', async () => {
    const { x, c } = await klass({ n: 0 });
    const g = await makeUser(t, Role.GUARDIAN);
    const minor = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05', name: 'Aziz Karimov' });
    await t.prisma.guardianLink.create({ data: { guardianId: g.id, studentId: minor.id, status: 'ACTIVE' } });
    await api(t, g.token).post('/classes/join', { code: c.joinCode, studentId: minor.id });
    const rows = (await api(t, g.token).get('/class-payments/mine')).body;
    assert.equal(rows.length, 1);
    assert.equal((await api(t, g.token).post(`/class-payments/${rows[0].id}/paid`)).status, 200);
    const stranger = await makeUser(t, Role.GUARDIAN);
    assert.equal((await api(t, stranger.token).post(`/class-payments/${rows[0].id}/paid`)).status, 404);
    assert.equal(await t.prisma.ledgerEntry.count({ where: { bookingId: rows[0].id } as any }).catch(() => 0), 0, 'no ledger is touched');
    assert.equal((await board(x.user, c.id)).rows[0].status, 'PUPIL_MARKED_PAID');
  });

  it('reminders: once per pupil per day, only to unpaid pupils, no card number in the notification; CSV export is safe and scoped', async () => {
    const { x, c, ps } = await klass({ n: 3 });
    await api(t, x.user.token).put('/teachers/me/payment-info', { cardNumber: '4111 1111 1111 1111', holderName: 'Ali Valiyev' });
    const b = await board(x.user, c.id);
    const id0 = b.rows.find((r: any) => r.pupilId === ps[0].id).id;
    await api(t, x.user.token).post(`/classes/${c.id}/money/mark`, { action: 'received', paymentIds: [id0] });
    const r1 = await api(t, x.user.token).post(`/classes/${c.id}/money/remind`, {});
    assert.deepEqual(r1.body, { reminded: 2, skipped: 0 }, 'the confirmed pupil is not reminded');
    const note = await t.prisma.notification.findFirstOrThrow({ where: { userId: ps[1].id, type: 'classpay.reminder' } });
    assert.deepEqual(note.data, { classId: c.id });
    assert.ok(!JSON.stringify(note).includes('4111'));
    assert.equal(await t.prisma.notification.count({ where: { userId: ps[0].id, type: 'classpay.reminder' } }), 0);
    const r2 = await api(t, x.user.token).post(`/classes/${c.id}/money/remind`, {});
    assert.equal(r2.status, 429);
    assert.equal(r2.body.code, 'REMIND_LIMIT');
    clock.set(new Date(clock.now().getTime() + 25 * 3_600_000));
    assert.equal((await api(t, x.user.token).post(`/classes/${c.id}/money/remind`, {})).body.reminded, 2, 'allowed again after a day');
    clock.set(new Date('2026-11-02T00:00:00Z'));
    // CSV
    await t.prisma.user.update({ where: { id: ps[1].id }, data: { name: '=HYPERLINK("http://evil","x")' } });
    const res = await fetch(`${t.baseUrl}/classes/${c.id}/money/export.csv`, { headers: { authorization: 'Bearer ' + x.user.token } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition')!, /^attachment/);
    const csv = await res.text();
    assert.equal(csv.split('\r\n')[0], 'pupil,period,amount_uzs,status,confirmed_at_utc');
    assert.equal(csv.trim().split('\r\n').length, 4);
    assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"",""x"")"`));
    assert.ok(csv.includes(',100000,'));
    assert.ok(![ps[0].email, ps[0].id].some((s) => csv.includes(s)));
    const other = await klass({ n: 1 });
    assert.equal((await fetch(`${t.baseUrl}/classes/${c.id}/money/export.csv`, { headers: { authorization: 'Bearer ' + other.x.user.token } })).status, 404);
  });

  it('requirePaidToJoin: unpaid pupils get a clear explanation; confirmation, waiver or a one-time pass opens the door; the free trial and free classes are never gated', async () => {
    const { x, c, ps, sessions } = await klass({ n: 3, oneOff: true, require: true });
    const sid = sessions[0].id;
    clock.set(at(-5));
    assert.equal((await api(t, x.user.token).post(`/class-sessions/${sid}/start`)).status, 200);
    const state = (await api(t, ps[0].token).get(`/class-sessions/${sid}`)).body;
    assert.equal(state.me.paymentGate.required, true);
    assert.equal(state.me.paymentGate.ok, false);
    const denied = await api(t, ps[0].token).post(`/class-sessions/${sid}/token`);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'PAYMENT_REQUIRED');
    assert.equal(denied.body.gate.status, 'UNPAID');
    assert.equal(denied.body.gate.amountMinor, PRICE);
    assert.match(denied.body.message, /pay the teacher directly/i, 'the explanation never claims protection or refunds');
    assert.ok(!/protect|refund|guarantee|escrow/i.test(denied.body.message));
    assert.equal((await api(t, x.user.token).post(`/class-sessions/${sid}/token`)).status, 200, 'the teacher is never gated');
    const rows = (await board(x.user, c.id)).rows;
    const idOf = (u: TestUser) => rows.find((r: any) => r.pupilId === u.id).id;
    // belgi qo'yish yetarli emas
    await api(t, ps[0].token).post(`/class-payments/${idOf(ps[0])}/paid`);
    assert.equal((await api(t, ps[0].token).post(`/class-sessions/${sid}/token`)).body.code, 'PAYMENT_REQUIRED', 'a pupil mark alone does not open the door');
    await api(t, x.user.token).post(`/classes/${c.id}/money/mark`, { action: 'received', paymentIds: [idOf(ps[0])] });
    assert.equal((await api(t, ps[0].token).post(`/class-sessions/${sid}/token`)).status, 200);
    await api(t, x.user.token).post(`/classes/${c.id}/money/mark`, { action: 'waive', paymentIds: [idOf(ps[1])] });
    assert.equal((await api(t, ps[1].token).post(`/class-sessions/${sid}/token`)).status, 200);
    // bir martalik ruxsat
    assert.equal((await api(t, ps[2].token).post(`/class-sessions/${sid}/token`)).status, 403);
    assert.equal((await api(t, ps[2].token).post(`/classes/${c.id}/money/override`, { sessionId: sid, pupilId: ps[2].id })).status, 403);
    assert.equal((await api(t, x.user.token).post(`/classes/${c.id}/money/override`, { sessionId: sid, pupilId: ps[2].id })).status, 200);
    assert.equal((await api(t, ps[2].token).post(`/class-sessions/${sid}/token`)).status, 200);
    // sinov va narxsiz sinf
    const tr = await klass({ n: 1, oneOff: true, require: true, trial: true });
    clock.set(at(-5));
    await api(t, tr.x.user.token).post(`/class-sessions/${tr.sessions[0].id}/start`);
    assert.equal((await api(t, tr.ps[0].token).post(`/class-sessions/${tr.sessions[0].id}/token`)).status, 200, 'free trial session');
    const free = await klass({ n: 1, oneOff: true, require: true, price: 0 });
    clock.set(at(-5));
    await api(t, free.x.user.token).post(`/class-sessions/${free.sessions[0].id}/start`);
    assert.equal((await api(t, free.ps[0].token).post(`/class-sessions/${free.sessions[0].id}/token`)).status, 200, 'a free class');
  });

  it('a teacher no-show waives that session (per-session classes) but never a confirmed payment', async () => {
    const { x, c, ps, sessions } = await klass({ n: 2, oneOff: true, model: 'PER_SESSION' });
    const rows = (await board(x.user, c.id)).rows;
    await api(t, x.user.token).post(`/classes/${c.id}/money/mark`, { action: 'received', paymentIds: [rows[0].id] });
    await api(t, ps[1].token).post(`/class-payments/${rows[1].id}/paid`);
    clock.set(at(16));
    await t.app.get(ClassRoomService).sweep();
    const after_ = (await board(x.user, c.id, `S:${sessions[0].id}`)).rows;
    const statuses = Object.fromEntries(after_.map((r: any) => [r.pupilId, r.status]));
    assert.equal(statuses[rows[0].pupilId], 'TEACHER_CONFIRMED');
    assert.equal(statuses[rows[1].pupilId], 'WAIVED');
    assert.equal((await t.prisma.classPayment.findUniqueOrThrow({ where: { id: rows[1].id } })).waivedReason, 'teacher_no_show');
  });

  it('card details: shown to a class pupil with a payment row, not to a trial-only pupil; "who owes me" lists class pupils with short names for minors', async () => {
    const paid = await klass({ n: 1 });
    await api(t, paid.x.user.token).put('/teachers/me/payment-info', { cardNumber: '4111 1111 1111 1111', holderName: 'Ali Valiyev' });
    assert.equal((await api(t, paid.ps[0].token).post(`/teachers/${paid.x.profileId}/payment-info/reveal`, {})).status, 403, 'no rows yet: nothing to pay');
    await api(t, paid.ps[0].token).get('/class-payments/mine'); // qatorlar yaratiladi
    const ok = await api(t, paid.ps[0].token).post(`/teachers/${paid.x.profileId}/payment-info/reveal`, {});
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.holderName, 'Ali Valiyev');
    const trial = await klass({ n: 1, oneOff: true, trial: true });
    await api(t, trial.x.user.token).put('/teachers/me/payment-info', { cardNumber: '4111 1111 1111 1111', holderName: 'Ali Valiyev' });
    await api(t, trial.ps[0].token).get('/class-payments/mine');
    assert.equal((await api(t, trial.ps[0].token).post(`/teachers/${trial.x.profileId}/payment-info/reveal`, {})).body.code, 'NOT_ELIGIBLE', 'the card is not revealed for a free trial');
    assert.equal((await api(t, (await makeUser(t)).token).post(`/teachers/${paid.x.profileId}/payment-info/reveal`, {})).status, 403);
    // kim qarz
    const g = await makeUser(t, Role.GUARDIAN);
    const minor = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05', name: 'Aziz Karimov' });
    await t.prisma.guardianLink.create({ data: { guardianId: g.id, studentId: minor.id, status: 'ACTIVE' } });
    const code = (await api(t, paid.x.user.token).post(`/classes/${paid.c.id}/regenerate-code`)).body.joinCode;
    await api(t, g.token).post('/classes/join', { code, studentId: minor.id });
    await board(paid.x.user, paid.c.id);
    const owed = (await api(t, paid.x.user.token).get('/teachers/me/money/class-owed')).body;
    assert.equal(owed.length, 2);
    assert.ok(owed.some((o: any) => o.pupilName === 'Aziz'), 'minors abbreviated');
    assert.ok(!JSON.stringify(owed).includes('Karimov') && !JSON.stringify(owed).includes(minor.id));
    assert.deepEqual((await api(t, trial.x.user.token).get('/teachers/me/money/class-owed')).body, []);
  });
});
