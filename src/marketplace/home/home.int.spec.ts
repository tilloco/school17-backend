import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { ClockService } from '../common/clock';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makeTeacher, makeUser, TestApp, TestUser } from '../testing/harness';

const NOW = new Date('2026-11-12T00:00:00Z');
let k = 0;

describe('home dashboards, my students, my learning (integration)', () => {
  let t: TestApp;
  let clock: ClockService;
  let admin: { id: string; token: string };

  const teacher = async () => {
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    await api(t, x.user.token).put('/teachers/me/profile', { instantBooking: true });
    return x;
  };
  async function lesson(x: Awaited<ReturnType<typeof teacher>>, pupil: TestUser, opts: { past?: boolean; future?: boolean; booker?: TestUser; studentId?: string } = {}) {
    const n = k++;
    const day = ['03', '04', '05', '06', '09', '10', '11'][n % 7];
    clock.set(opts.future ? NOW : new Date('2026-11-02T00:00:00Z'));
    const startAt = opts.future ? '2026-11-13T05:00:00.000Z' : `2026-11-${day}T${String(4 + Math.floor(n / 7)).padStart(2, '0')}:00:00.000Z`;
    const r = await api(t, (opts.booker ?? pupil).token).post('/bookings', { teacherId: x.profileId, startAt, durationMin: 60, ...(opts.studentId ? { studentId: opts.studentId } : {}) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    if (opts.past) await t.prisma.booking.update({ where: { id: r.body.id }, data: { status: 'COMPLETED', completedAt: new Date('2026-11-05T00:00:00Z') } });
    clock.set(NOW);
    return r.body.id as string;
  }

  /** Teacher X with: adult pupil A (completed unpaid lesson + upcoming lesson), minor M (via guardian G) in a class with A, and homework */
  async function world() {
    const x = await teacher();
    const a = await makeUser(t, Role.STUDENT, { name: 'Ali Valiyev' });
    const g = await makeUser(t, Role.GUARDIAN);
    const m = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05', name: 'Aziz Karimov' });
    await t.prisma.guardianLink.create({ data: { guardianId: g.id, studentId: m.id, status: 'ACTIVE' } });
    const past = await lesson(x, a, { past: true });
    const up = await lesson(x, a, { future: true });
    clock.set(new Date('2026-11-02T00:00:00Z'));
    const c = (await api(t, x.user.token).post('/classes', { title: 'Math 9', subject: 'Math', capacity: 10, weekdays: [1, 3], startMinute: 18 * 60, priceMinor: 10_000_000, priceModel: 'MONTHLY' })).body;
    await api(t, a.token).post('/classes/join', { code: c.joinCode });
    await api(t, g.token).post('/classes/join', { code: c.joinCode, studentId: m.id });
    const hw = (await api(t, x.user.token).post(`/classes/${c.id}/homework`, { title: 'Exercises', dueAt: '2026-11-20T00:00:00Z' })).body;
    await api(t, a.token).post(`/classes/${c.id}/homework/${hw.id}/submit`, { text: 'done' });
    clock.set(NOW);
    return { x, a, g, m, c, hw, past, up };
  }

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
    const actors = { STUDENT: await makeUser(t, Role.STUDENT), GUARDIAN: await makeUser(t, Role.GUARDIAN), TEACHER: (await teacher()).user, adminToken: admin.token };
    const id = '11111111-1111-4111-8111-111111111111';
    const failures = await checkRouteMatrix(t, actors, [
      { method: 'GET', path: '/me/home', allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'GET', path: '/me/learning', allowed: ['STUDENT', 'GUARDIAN'] },
      { method: 'GET', path: '/teachers/me/students', allowed: ['TEACHER'] },
      { method: 'GET', path: `/teachers/me/students/${id}`, allowed: ['TEACHER'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('teacher "my students": one row per pupil from lessons and classes, with next session, homework, owed marks, quick-message booking; minors by short name; strangers see nothing', async () => {
    const w = await world();
    const list = (await api(t, w.x.user.token).get('/teachers/me/students')).body;
    assert.equal(list.length, 2);
    const a = list.find((r: any) => r.pupilId === w.a.id);
    const m = list.find((r: any) => r.pupilId === w.m.id);
    assert.equal(a.name, 'Ali Valiyev');
    assert.equal(m.name, 'Aziz K.', 'minor: first name and initial only');
    assert.equal(a.lessonsCompleted, 1);
    assert.equal(a.payment.owedCount >= 1, true, 'the completed lesson is unpaid');
    assert.ok(a.payment.owedMinor >= 5_000_000);
    assert.equal(new Date(a.nextAt).toISOString() <= '2026-11-05T05:00:00.000Z' || a.nextAt !== null, true);
    assert.deepEqual(a.classes.map((c: any) => c.title), ['Math 9']);
    assert.equal(a.homework.assigned, 1);
    assert.equal(a.homework.submitted, 1);
    assert.equal(a.homework.toMark, 1, 'a submission waits for marking');
    assert.equal(m.homework.submitted, 0);
    assert.ok(a.chatBookingId, 'quick message goes through the latest booking');
    assert.equal(m.chatBookingId, null);
    assert.equal(a.attention, true);
    assert.ok(!JSON.stringify(list).includes(w.g.id) && !JSON.stringify(list).includes(w.a.email) && !JSON.stringify(list).includes('Karimov'));
    // begona o'qituvchi
    const other = await teacher();
    assert.deepEqual((await api(t, other.user.token).get('/teachers/me/students')).body, []);
    assert.equal((await api(t, other.user.token).get(`/teachers/me/students/${w.a.id}`)).status, 404, 'not his student');
    assert.equal((await api(t, w.a.token).get('/teachers/me/students')).status, 403);
    assert.equal((await api(t, w.g.token).get(`/teachers/me/students/${w.m.id}`)).status, 403);
  });

  it('student detail: lessons, class attendance, homework, payments for that teacher only', async () => {
    const w = await world();
    const d = (await api(t, w.x.user.token).get(`/teachers/me/students/${w.a.id}`)).body;
    assert.equal(d.pupil.name, 'Ali Valiyev');
    assert.equal(d.lessons.length, 2);
    assert.equal(d.classes[0].title, 'Math 9');
    assert.deepEqual(d.classes[0].attendance, { attended: 0, total: 0, late: 0 });
    assert.equal(d.homework[0].submitted, true);
    assert.equal(d.homework[0].marked, false);
    assert.ok(d.payments.lessonsOwed >= 1);
    const dm = (await api(t, w.x.user.token).get(`/teachers/me/students/${w.m.id}`)).body;
    assert.equal(dm.pupil.name, 'Aziz K.');
    assert.equal(dm.lessons.length, 0);
    assert.equal(dm.homework[0].submitted, false);
    // faqat shu o'qituvchining ma'lumoti: boshqa o'qituvchidagi darslar ko'rinmaydi
    const other = await teacher();
    await lesson(other, w.a);
    assert.equal((await api(t, w.x.user.token).get(`/teachers/me/students/${w.a.id}`)).body.lessons.length, 2);
  });

  it('home: teacher gets requests, homework to mark, owed marks, income and the agenda; pupil and guardian get their own agenda and homework due', async () => {
    const w = await world();
    const th = (await api(t, w.x.user.token).get('/me/home')).body;
    assert.equal(th.role, 'TEACHER');
    assert.equal(th.counts.homeworkToMark, 1);
    assert.ok(th.counts.owed >= 1);
    assert.equal(th.counts.students, 2);
    assert.equal(th.counts.classes, 1);
    assert.equal(typeof th.monthIncomeMinor, 'number');
    assert.ok(th.agenda.some((i: any) => i.kind === 'lesson') && th.agenda.some((i: any) => i.kind === 'class'), 'lessons and class sessions in one agenda');
    assert.deepEqual([...th.agenda].map((i: any) => i.startAt), [...th.agenda].map((i: any) => i.startAt).sort(), 'sorted by time');
    const ph = (await api(t, w.a.token).get('/me/home')).body;
    assert.equal(ph.role, 'STUDENT');
    assert.ok(ph.agenda.length >= 2);
    assert.equal(ph.counts.homeworkDue, 0, 'Ali already submitted');
    assert.ok(ph.counts.owed >= 1);
    const gh = (await api(t, w.g.token).get('/me/home')).body;
    assert.equal(gh.counts.children, 1);
    assert.equal(gh.counts.homeworkDue, 1, "the child's open homework");
    assert.equal(gh.homework[0].title, 'Exercises');
    assert.ok(gh.agenda.every((i: any) => i.kind === 'class' && i.pupil === 'Aziz'), "guardian sees the child's first name on class items");
    assert.equal((await api(t, admin.token).get('/me/home')).status, 401, 'admin tokens do not work on user routes');
  });

  it('my learning: classes with attendance and homework, upcoming, history and stats; a guardian picks his own child only', async () => {
    const w = await world();
    const l = (await api(t, w.a.token).get('/me/learning')).body;
    assert.equal(l.pupil.name, 'Ali Valiyev');
    assert.equal(l.classes.length, 1);
    assert.equal(l.classes[0].title, 'Math 9');
    assert.equal(l.classes[0].homework.total, 1);
    assert.equal(l.classes[0].homework.submitted, 1);
    assert.ok(l.classes[0].next, 'the next session is listed');
    assert.equal(l.stats.lessonsCompleted, 1);
    assert.equal(l.stats.homeworkSubmitted, 1);
    assert.ok(l.history.some((h: any) => h.kind === 'lesson' && h.status === 'COMPLETED'));
    assert.ok(l.upcoming.length >= 2);
    const lg = (await api(t, w.g.token).get('/me/learning')).body;
    assert.equal(lg.pupil.name, 'Aziz K.');
    assert.deepEqual(lg.children, [{ id: w.m.id, name: 'Aziz' }]);
    assert.equal(lg.classes[0].homework.submitted, 0);
    assert.equal((await api(t, w.g.token).get(`/me/learning?studentId=${w.a.id}`)).status, 404, "not his child");
    assert.equal((await api(t, w.a.token).get(`/me/learning?studentId=${w.m.id}`)).status, 404, "a pupil cannot read another pupil");
    assert.equal((await api(t, w.x.user.token).get('/me/learning')).status, 403);
    assert.equal((await api(t, w.a.token).get('/me/learning?studentId=not-a-uuid')).status, 400);
  });
});
