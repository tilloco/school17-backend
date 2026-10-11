import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { ClockService } from '../common/clock';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makeTeacher, makeUser, TestApp, TestUser } from '../testing/harness';
import { bayesianAverage } from './rating';

const NOW = new Date('2026-11-02T00:00:00Z');
let slotDay = 3;

describe('reviews (integration)', () => {
  let t: TestApp;
  let clock: ClockService;
  let admin: { id: string; token: string };

  /** Yakunlangan dars: bron yaratiladi va holat to'g'ridan-to'g'ri COMPLETED qilinadi (qo'ng'iroq oqimi S4 da sinalgan). */
  async function completed(opts: { student?: TestUser; teacher?: Awaited<ReturnType<typeof makeTeacher>>; status?: string; completedAt?: Date } = {}) {
    const tch = opts.teacher ?? (await makeTeacher(t, { approve: { adminToken: admin.token } }));
    await api(t, tch.user.token).put('/teachers/me/profile', { instantBooking: true });
    const student = opts.student ?? (await makeUser(t));
    clock.set(NOW);
    const days = ['03', '04', '05', '06', '09', '10', '11', '12'];
    const n = slotDay++;
    const start = `2026-11-${days[n % days.length]}T${String(4 + (Math.floor(n / days.length) % 8)).padStart(2, '0')}:00:00.000Z`;
    const b = await api(t, student.token).post('/bookings', { teacherId: tch.profileId, startAt: start, durationMin: 60 });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    await t.prisma.booking.update({ where: { id: b.body.id }, data: { status: (opts.status ?? 'COMPLETED') as any, completedAt: opts.completedAt ?? new Date('2026-11-02T00:00:00Z') } });
    return { tch, student, bookingId: b.body.id as string };
  }
  const review = (u: TestUser, bookingId: string, rating = 5, text = 'Great') => api(t, u.token).post(`/bookings/${bookingId}/review`, { rating, text });

  before(async () => {
    t = await createTestApp();
    clock = t.app.get(ClockService);
    clock.set(NOW);
    admin = await makeAdmin(t);
  });
  after(async () => {
    clock.set(null);
    await t.close();
  });

  it('route matrix', async () => {
    const actors = { STUDENT: await makeUser(t, Role.STUDENT), GUARDIAN: await makeUser(t, Role.GUARDIAN), TEACHER: await makeUser(t, Role.TEACHER), adminToken: admin.token };
    const id = '11111111-1111-4111-8111-111111111111';
    const failures = await checkRouteMatrix(t, actors, [
      { method: 'POST', path: '/bookings/' + id + '/review', body: { rating: 5 }, allowed: ['STUDENT', 'GUARDIAN'] },
      { method: 'PUT', path: '/reviews/' + id, body: { rating: 4 }, allowed: ['STUDENT', 'GUARDIAN'] },
      { method: 'PUT', path: '/reviews/' + id + '/reply', body: { text: 'thanks' }, allowed: ['TEACHER'] },
      { method: 'GET', path: '/reviews/mine', allowed: ['STUDENT', 'GUARDIAN'] },
      { method: 'POST', path: '/reviews/' + id + '/report', body: { reason: 'SPAM' }, allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'GET', path: '/teachers/' + id + '/reviews', allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'GET', path: '/admin/market/reports', scope: 'admin', allowed: ['ADMIN'] },
      { method: 'POST', path: '/admin/market/reviews/' + id + '/hide', body: {}, scope: 'admin', allowed: ['ADMIN'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('only COMPLETED lessons can be reviewed (not requested, cancelled, no-show, failed)', async () => {
    for (const status of ['CONFIRMED', 'CANCELLED', 'NO_SHOW_STUDENT', 'NO_SHOW_TEACHER', 'FAILED']) {
      const x = await completed({ status });
      const r = await review(x.student, x.bookingId);
      assert.equal(r.status, 409, status);
      assert.equal(r.body.code, 'NOT_COMPLETED');
    }
    const ok = await completed();
    assert.equal((await review(ok.student, ok.bookingId, 5, '  Excellent  ')).status, 201);
  });

  it('one review per lesson; validation; window; teachers and outsiders cannot review', async () => {
    const x = await completed();
    assert.equal((await review(x.student, x.bookingId, 0)).status, 400);
    assert.equal((await review(x.student, x.bookingId, 6)).status, 400);
    assert.equal((await review(x.student, x.bookingId, 4.5)).status, 400);
    assert.equal((await api(t, x.student.token).post(`/bookings/${x.bookingId}/review`, { rating: 5, authorId: 'x' })).status, 400, 'no mass assignment');
    assert.equal((await api(t, x.student.token).post(`/bookings/${x.bookingId}/review`, { rating: 5, text: 'x'.repeat(1001) })).status, 400);
    const first = await review(x.student, x.bookingId, 4, 'Good');
    assert.equal(first.status, 201);
    const dup = await review(x.student, x.bookingId, 5);
    assert.equal(dup.status, 409);
    assert.equal(dup.body.code, 'ALREADY_REVIEWED');
    // race: parallel duplicates => exactly one
    const y = await completed();
    const [a, b] = await Promise.all([review(y.student, y.bookingId, 5), review(y.student, y.bookingId, 1)]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    // o'qituvchi o'z darsiga sharh yoza olmaydi, begona ham
    const z = await completed();
    assert.equal((await api(t, z.tch.user.token).post(`/bookings/${z.bookingId}/review`, { rating: 5 })).status, 403, 'teacher role has no review.create');
    assert.equal((await review(await makeUser(t), z.bookingId)).status, 404);
    // oyna (30 kun)
    const old = await completed({ completedAt: new Date('2026-09-01T00:00:00Z') });
    const late = await review(old.student, old.bookingId);
    assert.equal(late.status, 409);
    assert.equal(late.body.code, 'WINDOW_CLOSED');
  });

  it('minors cannot review; the booking guardian does', async () => {
    const tch = await makeTeacher(t, { approve: { adminToken: admin.token } });
    await api(t, tch.user.token).put('/teachers/me/profile', { instantBooking: true });
    const guardian = await makeUser(t, Role.GUARDIAN);
    const minor = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05', name: 'Aziz Karimov' });
    await t.prisma.guardianLink.create({ data: { guardianId: guardian.id, studentId: minor.id, status: 'ACTIVE' } });
    const b = (await api(t, guardian.token).post('/bookings', { teacherId: tch.profileId, startAt: '2026-11-03T05:00:00.000Z', durationMin: 60, studentId: minor.id })).body;
    await t.prisma.booking.update({ where: { id: b.id }, data: { status: 'COMPLETED', completedAt: NOW } });
    assert.equal((await review(minor, b.id)).status, 404);
    assert.equal((await review(guardian, b.id)).status, 201);
    const list = (await api(t, minor.token).get(`/teachers/${tch.profileId}/reviews`)).body;
    assert.ok(!JSON.stringify(list).includes(guardian.id) && !JSON.stringify(list).includes(guardian.email));
  });

  it('aggregates use the Bayesian average, recomputed from visible reviews only', async () => {
    const tch = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const base = await t.prisma.teacherProfile.findUniqueOrThrow({ where: { id: tch.profileId } });
    assert.equal(base.ratingCount, 0);
    assert.equal(base.ratingBayes, 4.2, 'new teachers start at the prior mean (neither top nor bottom)');
    const ids: string[] = [];
    for (const rating of [5, 5, 3]) {
      const x = await completed({ teacher: tch });
      const r = await review(x.student, x.bookingId, rating);
      assert.equal(r.status, 201);
      ids.push(r.body.id);
    }
    let p = await t.prisma.teacherProfile.findUniqueOrThrow({ where: { id: tch.profileId } });
    assert.equal(p.ratingCount, 3);
    assert.equal(p.ratingSum, 13);
    assert.ok(Math.abs(p.ratingBayes - bayesianAverage(13, 3, 4.2, 5)) < 1e-9);
    assert.ok(p.ratingBayes < 13 / 3, 'shrunk below the raw 4.33 average? prior 4.2 pulls toward 4.2');
    // admin yashirsa agregat qayta hisoblanadi
    await api(t, admin.token).post(`/admin/market/reviews/${ids[2]}/hide`, { reason: 'abusive' });
    p = await t.prisma.teacherProfile.findUniqueOrThrow({ where: { id: tch.profileId } });
    assert.equal(p.ratingCount, 2);
    assert.equal(p.ratingSum, 10);
    await api(t, admin.token).post(`/admin/market/reviews/${ids[2]}/restore`);
    assert.equal((await t.prisma.teacherProfile.findUniqueOrThrow({ where: { id: tch.profileId } })).ratingCount, 3);
    // jamoat ro'yxati
    const pub = (await api(t, (await makeUser(t)).token).get(`/teachers/${tch.profileId}/reviews`)).body;
    assert.equal(pub.summary.count, 3);
    assert.deepEqual(pub.summary.distribution, { 1: 0, 2: 0, 3: 1, 4: 0, 5: 2 });
    assert.equal(pub.items.length, 3);
    assert.ok(pub.items.every((i: any) => /^\S+( \S\.)?$/.test(i.author) || i.author.length > 0));
  });

  it('one 5-star review from a brand-new account cannot outrank a long track record', async () => {
    const veteran = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const newbie = await makeTeacher(t, { approve: { adminToken: admin.token } });
    for (let i = 0; i < 8; i++) {
      const x = await completed({ teacher: veteran });
      await review(x.student, x.bookingId, i < 6 ? 5 : 4);
    }
    const x = await completed({ teacher: newbie });
    await review(x.student, x.bookingId, 5);
    const v = await t.prisma.teacherProfile.findUniqueOrThrow({ where: { id: veteran.profileId } });
    const n = await t.prisma.teacherProfile.findUniqueOrThrow({ where: { id: newbie.profileId } });
    assert.ok(v.ratingBayes > n.ratingBayes);
  });

  it('author can edit within 48h only; hidden reviews are locked', async () => {
    const x = await completed();
    const r = (await review(x.student, x.bookingId, 3, 'meh')).body;
    const other = await makeUser(t);
    assert.equal((await api(t, other.token).put('/reviews/' + r.id, { rating: 1 })).status, 404, 'IDOR');
    assert.equal((await api(t, x.student.token).put('/reviews/' + r.id, { rating: 4, text: 'better' })).status, 200);
    assert.equal((await t.prisma.teacherProfile.findUniqueOrThrow({ where: { id: x.tch.profileId } })).ratingSum, 4);
    clock.set(new Date(NOW.getTime() + 49 * 3_600_000));
    const late = await api(t, x.student.token).put('/reviews/' + r.id, { rating: 1 });
    assert.equal(late.status, 409);
    assert.equal(late.body.code, 'EDIT_WINDOW_CLOSED');
    clock.set(NOW);
    await api(t, admin.token).post(`/admin/market/reviews/${r.id}/hide`, {});
    assert.equal((await api(t, x.student.token).put('/reviews/' + r.id, { rating: 5 })).status, 409);
  });

  it('teacher reply: only the reviewed teacher, one thread entry, editable 48h, not on hidden reviews', async () => {
    const x = await completed();
    const r = (await review(x.student, x.bookingId, 2, 'Late start')).body;
    const otherTeacher = await makeTeacher(t, { approve: { adminToken: admin.token } });
    assert.equal((await api(t, otherTeacher.user.token).put(`/reviews/${r.id}/reply`, { text: 'hi' })).status, 404);
    assert.equal((await api(t, x.student.token).put(`/reviews/${r.id}/reply`, { text: 'hi' })).status, 403);
    assert.equal((await api(t, x.tch.user.token).put(`/reviews/${r.id}/reply`, { text: '   ' })).status, 400);
    const rep = await api(t, x.tch.user.token).put(`/reviews/${r.id}/reply`, { text: 'Sorry about that, my train was late.' });
    assert.equal(rep.status, 200);
    assert.equal(rep.body.reply.text, 'Sorry about that, my train was late.');
    const pub = (await api(t, x.student.token).get(`/teachers/${x.tch.profileId}/reviews`)).body;
    assert.equal(pub.items[0].reply.text, 'Sorry about that, my train was late.');
    clock.set(new Date(NOW.getTime() + 49 * 3_600_000));
    assert.equal((await api(t, x.tch.user.token).put(`/reviews/${r.id}/reply`, { text: 'changed' })).status, 409);
    clock.set(NOW);
  });

  it('report a review: not your own, once per reporter, moderation queue resolves it (hide or dismiss) with audit', async () => {
    const x = await completed();
    const r = (await review(x.student, x.bookingId, 1, 'Terrible, call me on +998 90 000 00 00')).body;
    assert.equal((await api(t, x.student.token).post(`/reviews/${r.id}/report`, { reason: 'OTHER' })).status, 403, 'author cannot report own review');
    const rep = await api(t, x.tch.user.token).post(`/reviews/${r.id}/report`, { reason: 'PERSONAL_DATA', note: 'contains a phone number' });
    assert.equal(rep.status, 201);
    const dup = await api(t, x.tch.user.token).post(`/reviews/${r.id}/report`, { reason: 'SPAM' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.code, 'ALREADY_REPORTED');
    assert.equal((await api(t, x.tch.user.token).post(`/reviews/${r.id}/report`, { reason: 'NOPE' })).status, 400);
    assert.equal((await api(t, x.tch.user.token).post('/reviews/11111111-1111-4111-8111-111111111111/report', { reason: 'SPAM' })).status, 404);

    const q = (await api(t, admin.token).get('/admin/market/reports?targetType=REVIEW')).body;
    const item = q.find((i: any) => i.id === rep.body.id);
    assert.ok(item);
    assert.equal(item.target.text.startsWith('Terrible'), true);
    assert.equal((await api(t, x.tch.user.token).get('/admin/market/reports')).status, 401, 'teachers cannot see the queue');
    const res = await api(t, admin.token).post(`/admin/market/reports/${rep.body.id}/resolve`, { action: 'ACTION', note: 'phone number' });
    assert.equal(res.body.status, 'ACTIONED');
    assert.equal((await t.prisma.review.findUniqueOrThrow({ where: { id: r.id } })).status, 'HIDDEN');
    assert.equal((await t.prisma.teacherProfile.findUniqueOrThrow({ where: { id: x.tch.profileId } })).ratingCount, 0);
    assert.equal((await api(t, admin.token).post(`/admin/market/reports/${rep.body.id}/resolve`, { action: 'DISMISS' })).status, 409);
    assert.ok(await t.prisma.auditLog.findFirst({ where: { action: 'report.action', actorType: 'ADMIN' } }));
    // hidden reviews can no longer be reported and disappear from the public list
    assert.equal((await api(t, x.tch.user.token).post(`/reviews/${r.id}/report`, { reason: 'SPAM' })).status, 404);
    assert.equal((await api(t, x.student.token).get(`/teachers/${x.tch.profileId}/reviews`)).body.items.length, 0);

    const y = await completed({ teacher: x.tch });
    const r2 = (await review(y.student, y.bookingId, 5)).body;
    const rep2 = await api(t, x.tch.user.token).post(`/reviews/${r2.id}/report`, { reason: 'FAKE' });
    assert.equal((await api(t, admin.token).post(`/admin/market/reports/${rep2.body.id}/resolve`, { action: 'DISMISS' })).body.status, 'DISMISSED');
    assert.equal((await t.prisma.review.findUniqueOrThrow({ where: { id: r2.id } })).status, 'VISIBLE');
  });

  it('pending list and mine only show the caller\'s own data', async () => {
    const x = await completed();
    const other = await makeUser(t);
    assert.deepEqual((await api(t, other.token).get('/reviews/pending')).body, []);
    const pend = (await api(t, x.student.token).get('/reviews/pending')).body;
    assert.equal(pend.length, 1);
    assert.equal(pend[0].bookingId, x.bookingId);
    await review(x.student, x.bookingId);
    assert.equal((await api(t, x.student.token).get('/reviews/pending')).body.length, 0);
    assert.equal((await api(t, x.student.token).get('/reviews/mine')).body.length, 1);
    assert.equal((await api(t, other.token).get('/reviews/mine')).body.length, 0);
  });
});
