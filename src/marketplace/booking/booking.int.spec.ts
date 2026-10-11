import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { ClockService } from '../common/clock';
import {
  api, checkRouteMatrix, createTestApp, makeAdmin, makeTeacher, makeUser, TestApp, TestUser,
} from '../testing/harness';

// Qat'iy "hozir": dushanba 2026-11-02 00:00Z (Toshkent 05:00). O'qituvchi Du-Ju 09:00-18:00 Toshkent = 04:00-13:00Z.
const NOW = new Date('2026-11-02T00:00:00Z');
const TUE_10 = '2026-11-03T05:00:00.000Z'; // seshanba 10:00 Toshkent
const TUE_11 = '2026-11-03T06:00:00.000Z';
const TUE_12 = '2026-11-03T07:00:00.000Z';

describe('bookings (integration)', () => {
  let t: TestApp;
  let admin: { id: string; token: string };
  let clock: ClockService;

  const teacher = (instant = false) =>
    makeTeacher(t, { approve: { adminToken: admin.token } }).then(async (x) => {
      if (instant) await api(t, x.user.token).put('/teachers/me/profile', { instantBooking: true });
      return x;
    });

  const book = (u: TestUser, teacherId: string, startAt: string, extra: Record<string, unknown> = {}) =>
    api(t, u.token).post('/bookings', { teacherId, startAt, durationMin: 60, ...extra });

  before(async () => {
    t = await createTestApp();
    admin = await makeAdmin(t);
    clock = t.app.get(ClockService);
    clock.set(NOW);
  });
  after(async () => {
    clock.set(null);
    await t.close();
  });

  it('route matrix', async () => {
    const actors = {
      STUDENT: await makeUser(t, Role.STUDENT),
      GUARDIAN: await makeUser(t, Role.GUARDIAN),
      TEACHER: await makeUser(t, Role.TEACHER),
      adminToken: admin.token,
    };
    const id = '11111111-1111-4111-8111-111111111111';
    const failures = await checkRouteMatrix(t, actors, [
      { method: 'POST', path: '/bookings', body: { teacherId: id, startAt: TUE_10, durationMin: 60 }, allowed: ['STUDENT', 'GUARDIAN'] },
      { method: 'GET', path: '/bookings?from=2026-11-01T00:00:00Z&to=2026-11-30T00:00:00Z', allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'GET', path: '/bookings/' + id, allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'POST', path: '/bookings/' + id + '/accept', allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'POST', path: '/bookings/' + id + '/cancel', allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('slots respect availability, timezone, notice and existing bookings', async () => {
    const { profileId } = await teacher();
    const s = await makeUser(t);
    const res = await api(t, s.token).get('/teachers/' + profileId + '/slots?from=2026-11-03T00:00:00Z&to=2026-11-04T00:00:00Z&duration=60');
    assert.equal(res.status, 200);
    assert.equal(res.body.timezone, 'Asia/Tashkent');
    assert.equal(res.body.slots[0], '2026-11-03T04:00:00.000Z'); // 09:00 Toshkent
    assert.equal(res.body.slots.at(-1), '2026-11-03T12:00:00.000Z'); // oxirgi slot 17:00 -> 18:00
    const sun = await api(t, s.token).get('/teachers/' + profileId + '/slots?from=2026-11-08T00:00:00Z&to=2026-11-09T00:00:00Z');
    assert.deepEqual(sun.body.slots, []); // yakshanba - ish kuni emas
    assert.equal((await book(s, profileId, TUE_10)).status, 201);
    const after = await api(t, s.token).get('/teachers/' + profileId + '/slots?from=2026-11-03T00:00:00Z&to=2026-11-04T00:00:00Z&duration=60');
    assert.ok(!after.body.slots.includes(TUE_10));
    assert.ok(!after.body.slots.includes('2026-11-03T05:30:00.000Z'), 'overlapping half-hour start must be gone');
    assert.ok(after.body.slots.includes(TUE_11));
  });

  it('request -> accept flow; reminders scheduled; cancel removes them', async () => {
    const { user: tu, profileId } = await teacher();
    const s = await makeUser(t);
    const r = await book(s, profileId, TUE_10);
    assert.equal(r.status, 201);
    assert.equal(r.body.status, 'REQUESTED');
    assert.equal(r.body.priceMinor, 5_000_000);
    const id = r.body.id;
    assert.equal((await api(t, s.token).post('/bookings/' + id + '/accept')).status, 404, 'student cannot accept');
    const ok = await api(t, tu.token).post('/bookings/' + id + '/accept');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, 'CONFIRMED');
    const reminders = await t.prisma.notification.findMany({ where: { dedupeKey: { startsWith: 'booking:' + id + ':reminder' } } });
    assert.equal(reminders.length, 4); // 2 vaqt x 2 noyob foydalanuvchi (o'quvchi = bronlovchi)
    await api(t, s.token).post('/bookings/' + id + '/cancel');
    assert.equal(await t.prisma.notification.count({ where: { dedupeKey: { startsWith: 'booking:' + id + ':reminder' } } }), 0);
  });

  it('instant booking confirms immediately', async () => {
    const { profileId } = await teacher(true);
    const s = await makeUser(t);
    const r = await book(s, profileId, TUE_10);
    assert.equal(r.body.status, 'CONFIRMED');
  });

  it('cannot book outside availability, in the past, too soon, or unverified teacher', async () => {
    const { profileId } = await teacher();
    const s = await makeUser(t);
    assert.equal((await book(s, profileId, '2026-11-03T02:00:00.000Z')).status, 409); // 07:00 Toshkent
    assert.equal((await book(s, profileId, '2026-11-01T05:00:00.000Z')).status, 400); // o'tmish
    assert.equal((await book(s, profileId, '2026-11-02T00:30:00.000Z')).status, 400); // 1 soatlik ogohlantirishdan kam
    assert.equal((await book(s, profileId, '2026-11-03T05:10:00.000Z')).status, 400); // 15 daqiqalik chegarada emas
    const unverified = await makeTeacher(t, { submit: true });
    assert.equal((await book(s, unverified.profileId, TUE_10)).status, 404);
    assert.equal((await api(t, s.token).post('/bookings', { teacherId: profileId, startAt: TUE_10, durationMin: 77 })).status, 400);
  });

  it('race: two students book the same slot at once -> exactly one wins', async () => {
    const { profileId } = await teacher(true);
    const [a, b] = await Promise.all([makeUser(t), makeUser(t)]);
    const [ra, rb] = await Promise.all([book(a, profileId, TUE_10), book(b, profileId, TUE_10)]);
    assert.deepEqual([ra.status, rb.status].sort(), [201, 409]);
  });

  it('a student cannot be in two lessons at the same time', async () => {
    const t1 = await teacher(true);
    const t2 = await teacher(true);
    const s = await makeUser(t);
    assert.equal((await book(s, t1.profileId, TUE_10)).status, 201);
    assert.equal((await book(s, t2.profileId, TUE_10)).status, 409);
    assert.equal((await book(s, t2.profileId, TUE_12)).status, 201);
  });

  it('teacher cannot book themselves', async () => {
    const x = await teacher(true);
    const asStudent = await makeUser(t, Role.STUDENT); // teacherning o'zi STUDENT rolida emas, shuning uchun 403
    assert.equal((await api(t, x.user.token).post('/bookings', { teacherId: x.profileId, startAt: TUE_10, durationMin: 60 })).status, 403);
    assert.ok(asStudent);
  });

  it('minors: cannot self-book; only a linked guardian can; guardian cannot book for adults or unlinked pupils', async () => {
    const { profileId } = await teacher(true);
    const minor = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05' });
    const guardian = await makeUser(t, Role.GUARDIAN);
    const stranger = await makeUser(t, Role.GUARDIAN);
    const adult = await makeUser(t, Role.STUDENT);
    assert.equal((await book(minor, profileId, TUE_10)).status, 403);
    assert.equal((await book(guardian, profileId, TUE_10, { studentId: minor.id })).status, 404, 'not linked');
    await t.prisma.guardianLink.create({ data: { guardianId: guardian.id, studentId: minor.id, status: 'ACTIVE' } });
    await t.prisma.guardianLink.create({ data: { guardianId: guardian.id, studentId: adult.id, status: 'ACTIVE' } });
    assert.equal((await book(stranger, profileId, TUE_10, { studentId: minor.id })).status, 404);
    assert.equal((await book(guardian, profileId, TUE_10, { studentId: adult.id })).status, 403);
    const ok = await book(guardian, profileId, TUE_10, { studentId: minor.id });
    assert.equal(ok.status, 201);
    // vasiy va o'quvchi ko'radi, begona vasiy ko'rmaydi
    assert.equal((await api(t, guardian.token).get('/bookings/' + ok.body.id)).status, 200);
    assert.equal((await api(t, minor.token).get('/bookings/' + ok.body.id)).status, 200);
    assert.equal((await api(t, stranger.token).get('/bookings/' + ok.body.id)).status, 404);
  });

  it('IDOR: outsiders get 404 for view/cancel/accept/no-show/reschedule', async () => {
    const { user: tu, profileId } = await teacher(true);
    const other = await teacher();
    const s = await makeUser(t);
    const outsider = await makeUser(t);
    const b = (await book(s, profileId, TUE_10)).body;
    for (const [m, p] of [
      ['get', '/bookings/' + b.id], ['post', '/bookings/' + b.id + '/cancel'], ['post', '/bookings/' + b.id + '/accept'],
      ['post', '/bookings/' + b.id + '/no-show'], ['post', '/bookings/' + b.id + '/reschedule'],
    ] as const) {
      const c: any = api(t, outsider.token);
      const res = await c[m](p, m === 'post' ? { startAt: TUE_11 } : undefined);
      assert.ok(res.status === 404 || res.status === 400 && p.endsWith('reschedule') === false, m + ' ' + p + ' -> ' + res.status);
    }
    assert.equal((await api(t, other.user.token).post('/bookings/' + b.id + '/cancel')).status, 404, 'other teacher');
    assert.equal((await api(t, outsider.token).get('/bookings?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z')).body.length, 0);
    assert.equal((await api(t, tu.token).get('/bookings?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z')).body.length >= 1, true);
  });

  it('teacher sees only the pupil display name (abbreviated for minors), never email or user id', async () => {
    const { user: tu, profileId } = await teacher(true);
    const guardian = await makeUser(t, Role.GUARDIAN);
    const minor = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05', name: 'Aziz Karimov' });
    await t.prisma.guardianLink.create({ data: { guardianId: guardian.id, studentId: minor.id, status: 'ACTIVE' } });
    const b = (await book(guardian, profileId, TUE_10, { studentId: minor.id })).body;
    const view = await api(t, tu.token).get('/bookings/' + b.id);
    assert.deepEqual(view.body.student, { name: 'Aziz K.' });
    const raw = JSON.stringify(view.body);
    assert.ok(!raw.includes(minor.email) && !raw.includes(guardian.email) && !raw.includes(minor.id) && !raw.includes(guardian.id));
  });

  it('cancellation: early = full refund; late student = policy; teacher always full; after start rejected', async () => {
    const { user: tu, profileId } = await teacher(true);
    const s = await makeUser(t);
    const early = (await book(s, profileId, '2026-11-05T05:00:00.000Z')).body; // 3 kun keyin
    const c1 = await api(t, s.token).post('/bookings/' + early.id + '/cancel', { reason: 'busy' });
    assert.equal(c1.status, 200);
    assert.equal(c1.body.status, 'CANCELLED');
    assert.equal(c1.body.refundBps, 10000);
    assert.equal(c1.body.cancel.late, false);
    // kech: darsga 2 soat qolganda
    const lateB = (await book(s, profileId, '2026-11-02T03:00:00.000Z')).body; // 08:00 Toshkent = 03:00Z (kutish: mavjudlik 09:00 dan)
    assert.equal(lateB.id, undefined, 'outside availability');
    const slot = (await book(s, profileId, '2026-11-02T04:00:00.000Z')); // 04:00Z = NOW+4h
    assert.equal(slot.status, 201);
    clock.set(new Date('2026-11-02T02:30:00Z')); // darsga 1.5 soat
    const c2 = await api(t, s.token).post('/bookings/' + slot.body.id + '/cancel');
    assert.equal(c2.body.cancel.late, true);
    assert.equal(c2.body.refundBps, 0);
    // o'qituvchi kech bekor qilsa ham to'liq qaytarish
    clock.set(NOW);
    const tb = (await book(s, profileId, '2026-11-02T05:00:00.000Z')).body;
    clock.set(new Date('2026-11-02T03:30:00Z'));
    const c3 = await api(t, tu.token).post('/bookings/' + tb.id + '/cancel');
    assert.equal(c3.body.refundBps, 10000);
    assert.equal(c3.body.cancel.by, 'TEACHER');
    clock.set(NOW);
    // allaqachon bekor qilingan => qayta bekor qilib bo'lmaydi
    assert.equal((await api(t, s.token).post('/bookings/' + early.id + '/cancel')).status, 409);
    // boshlangandan keyin bekor qilib bo'lmaydi
    const run = (await book(s, profileId, '2026-11-03T05:00:00.000Z')).body;
    clock.set(new Date('2026-11-03T05:10:00Z'));
    assert.equal((await api(t, s.token).post('/bookings/' + run.id + '/cancel')).status, 409);
    clock.set(NOW);
  });

  it('reschedule: proposal must be accepted by the OTHER side; slot re-validated', async () => {
    const { user: tu, profileId } = await teacher(true);
    const s = await makeUser(t);
    const b = (await book(s, profileId, TUE_10)).body;
    const prop = await api(t, s.token).post('/bookings/' + b.id + '/reschedule', { startAt: TUE_12 });
    assert.equal(prop.status, 200);
    assert.equal(prop.body.reschedule.byMe, true);
    assert.equal((await api(t, s.token).post('/bookings/' + b.id + '/reschedule/accept')).status, 403, 'proposer cannot self-accept');
    const acc = await api(t, tu.token).post('/bookings/' + b.id + '/reschedule/accept');
    assert.equal(acc.status, 200);
    assert.equal(acc.body.startAt, TUE_12);
    assert.equal(acc.body.reschedule, null);
    // yangi slot band bo'lsa taklif rad etiladi
    const other = await makeUser(t);
    await book(other, profileId, TUE_11);
    assert.equal((await api(t, s.token).post('/bookings/' + b.id + '/reschedule', { startAt: TUE_11 })).status, 409);
    // darsga <12 soat qolganda ko'chirib bo'lmaydi
    clock.set(new Date('2026-11-03T00:00:00Z'));
    assert.equal((await api(t, s.token).post('/bookings/' + b.id + '/reschedule', { startAt: '2026-11-03T09:00:00.000Z' })).status, 409);
    clock.set(NOW);
  });

  it('requests expire and free the slot', async () => {
    const { profileId } = await teacher();
    const a = await makeUser(t);
    const b = await makeUser(t);
    const r = (await book(a, profileId, '2026-11-05T05:00:00.000Z')).body;
    assert.equal((await book(b, profileId, '2026-11-05T05:00:00.000Z')).status, 409);
    clock.set(new Date('2026-11-03T01:00:00Z')); // 25 soat o'tdi
    assert.equal((await book(b, profileId, '2026-11-05T05:00:00.000Z')).status, 201);
    assert.equal((await api(t, a.token).get('/bookings/' + r.id)).body.status, 'EXPIRED');
    clock.set(NOW);
  });

  it('no-show: too early rejected; correct side only; marks status', async () => {
    const { user: tu, profileId } = await teacher(true);
    const s = await makeUser(t);
    const b = (await book(s, profileId, TUE_10)).body;
    clock.set(new Date('2026-11-03T05:05:00Z'));
    assert.equal((await api(t, tu.token).post('/bookings/' + b.id + '/no-show')).status, 409, 'grace period not over');
    clock.set(new Date('2026-11-03T05:12:00Z'));
    const r = await api(t, tu.token).post('/bookings/' + b.id + '/no-show');
    assert.equal(r.body.status, 'NO_SHOW_STUDENT');
    assert.equal((await api(t, s.token).post('/bookings/' + b.id + '/no-show')).status, 409, 'already resolved');
    clock.set(NOW);
  });

  it('join window flag follows the clock', async () => {
    const { profileId } = await teacher(true);
    const s = await makeUser(t);
    const b = (await book(s, profileId, TUE_10)).body;
    const probe = async (iso: string) => {
      clock.set(new Date(iso));
      return (await api(t, s.token).get('/bookings/' + b.id)).body.canJoinNow;
    };
    assert.equal(await probe('2026-11-03T04:50:00Z'), false); // 10 daq oldin
    assert.equal(await probe('2026-11-03T04:56:00Z'), true); // 4 daq oldin
    assert.equal(await probe('2026-11-03T06:04:00Z'), true); // tugagandan 4 daq keyin
    assert.equal(await probe('2026-11-03T06:06:00Z'), false);
    clock.set(NOW);
  });
});
