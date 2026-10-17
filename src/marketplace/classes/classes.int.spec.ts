import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { ClockService } from '../common/clock';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makeTeacher, makeUser, TestApp } from '../testing/harness';

const NOW = new Date('2026-11-02T00:00:00Z'); // dushanba

describe('classes: model and enrollment (R1, integration)', () => {
  let t: TestApp;
  let clock: ClockService;
  let admin: { id: string; token: string };

  const teacher = () => makeTeacher(t, { approve: { adminToken: admin.token } });
  const weekly = (extra: object = {}) => ({ title: 'Math 9', subject: 'Mathematics', capacity: 3, weekdays: [1, 3], startMinute: 18 * 60, durationMin: 60, ...extra });
  async function mkClass(x: Awaited<ReturnType<typeof teacher>>, extra: object = {}) {
    const r = await api(t, x.user.token).post('/classes', weekly(extra));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body as { id: string; joinCode: string; inviteToken: string; capacity: number };
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
    const actors = { STUDENT: await makeUser(t, Role.STUDENT), GUARDIAN: await makeUser(t, Role.GUARDIAN), TEACHER: await teacher().then((x) => x.user), adminToken: admin.token };
    const id = '11111111-1111-4111-8111-111111111111';
    const failures = await checkRouteMatrix(t, actors, [
      { method: 'POST', path: '/classes', body: {}, allowed: ['TEACHER'] },
      { method: 'GET', path: '/classes/mine', allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'GET', path: `/classes/${id}`, allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'PATCH', path: `/classes/${id}`, body: {}, allowed: ['TEACHER'] },
      { method: 'POST', path: `/classes/${id}/cancel`, allowed: ['TEACHER'] },
      { method: 'POST', path: `/classes/${id}/regenerate-code`, allowed: ['TEACHER'] },
      { method: 'POST', path: '/classes/join', body: { code: 'ABCD2345' }, allowed: ['STUDENT', 'GUARDIAN'] },
      { method: 'DELETE', path: `/classes/${id}/pupils/${id}`, allowed: ['TEACHER'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('creates a class with 4 weeks of sessions, idempotently; validates input; only verified teachers', async () => {
    const x = await teacher();
    const c = await mkClass(x);
    assert.match(c.joinCode, /^[A-HJKMNP-Z2-9]{8}$/);
    assert.ok(c.inviteToken.length >= 20);
    const s = (await api(t, x.user.token).get(`/classes/${c.id}/sessions?from=2026-11-02T00:00:00Z&to=2027-01-01T00:00:00Z`)).body;
    assert.equal(s.length, 8, 'Mon+Wed for 4 weeks');
    assert.equal(s[0].startAt, '2026-11-02T13:00:00.000Z', '18:00 Tashkent');
    const svc = (await import('./classes.service')).ClassesService;
    assert.equal(await t.app.get(svc).ensureSessions(c.id), 0, 'second run creates nothing');
    clock.set(new Date('2026-11-09T00:00:00Z'));
    assert.equal(await t.app.get(svc).ensureSessions(c.id), 2, 'a week later: one more week is added');
    clock.set(NOW);
    for (const bad of [{ capacity: 501 }, { capacity: 0 }, { weekdays: [8] }, { startMinute: 2000 }, { durationMin: 5 }, { priceMinor: -1 }, { timezone: 'Mars/Base' }, { oneOffStartAt: '2026-11-05T10:00:00Z' }]) {
      const r = await api(t, x.user.token).post('/classes', weekly(bad));
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    const pending = await makeTeacher(t, { submit: true });
    assert.equal((await api(t, pending.user.token).post('/classes', weekly())).status, 403, 'unverified teacher');
    assert.equal((await api(t, (await makeUser(t)).token).post('/classes', weekly())).status, 403, 'pupil');
    const one = await api(t, x.user.token).post('/classes', { title: 'Intro', subject: 'Math', capacity: 5, oneOffStartAt: '2026-11-05T10:00:00Z', firstSessionTrial: true });
    assert.equal(one.status, 201, JSON.stringify(one.body));
    const os = (await api(t, x.user.token).get(`/classes/${one.body.id}/sessions`)).body;
    assert.equal(os.length, 1);
    assert.equal(os[0].isTrial, true, 'first session flagged as free trial');
  });

  it('enrolls by code and by invite link; codes are stored hashed; wrong code and attempt limit', async () => {
    const x = await teacher();
    const c = await mkClass(x);
    const row = await t.prisma.class.findUniqueOrThrow({ where: { id: c.id } });
    assert.ok(!JSON.stringify(row).includes(c.joinCode) && !JSON.stringify(row).includes(c.inviteToken), 'no plaintext code or token in the database');
    const a = await makeUser(t);
    const b = await makeUser(t);
    const ja = await api(t, a.token).post('/classes/join', { code: c.joinCode.toLowerCase() });
    assert.equal(ja.status, 200, JSON.stringify(ja.body));
    assert.equal(ja.body.title, 'Math 9');
    assert.equal((await api(t, a.token).post('/classes/join', { code: c.joinCode })).status, 409, 'twice');
    assert.equal((await api(t, b.token).post('/classes/join', { token: c.inviteToken })).status, 200, 'invite link');
    // noto'g'ri kodlar: 404 va urinish chegarasi (har bir foydalanuvchiga soatiga 10)
    const guesser = await makeUser(t);
    for (let i = 0; i < 10; i++) assert.equal((await api(t, guesser.token).post('/classes/join', { code: 'ZZZZ2222' })).status, 404);
    const limited = await api(t, guesser.token).post('/classes/join', { code: c.joinCode });
    assert.equal(limited.status, 429, 'even the right code is refused after 10 attempts');
    assert.equal(limited.body.code, 'JOIN_LIMIT');
    clock.set(new Date(NOW.getTime() + 61 * 60_000));
    assert.equal((await api(t, guesser.token).post('/classes/join', { code: c.joinCode })).status, 200, 'allowed again after an hour');
    clock.set(NOW);
  });

  it('capacity is atomic: of 8 parallel joins into a class of 3, exactly 3 succeed (the 31st-pupil rule)', async () => {
    const x = await teacher();
    const c = await mkClass(x, { capacity: 3 });
    const users = await Promise.all(Array.from({ length: 8 }, () => makeUser(t)));
    const res = await Promise.all(users.map((u) => api(t, u.token).post('/classes/join', { code: c.joinCode })));
    assert.equal(res.filter((r) => r.status === 200).length, 3);
    assert.deepEqual([...new Set(res.filter((r) => r.status !== 200).map((r) => r.body.code))], ['CLASS_FULL']);
    const row = await t.prisma.class.findUniqueOrThrow({ where: { id: c.id } });
    assert.equal(row.enrolledCount, 3);
    assert.equal(await t.prisma.classEnrollment.count({ where: { classId: c.id, status: 'ACTIVE' } }), 3);
  });

  it('a class of 30: the 31st pupil is refused', async () => {
    const x = await teacher();
    const c = await mkClass(x, { capacity: 30 });
    const users = await Promise.all(Array.from({ length: 31 }, () => makeUser(t)));
    const res = await Promise.all(users.map((u) => api(t, u.token).post('/classes/join', { code: c.joinCode })));
    assert.equal(res.filter((r) => r.status === 200).length, 30);
    assert.equal(res.filter((r) => r.status === 409).length, 1);
  });

  it('minors: alone or through a linked guardian; adults cannot be enrolled by a guardian; block and removal prevent enrollment', async () => {
    const x = await teacher();
    const c = await mkClass(x);
    const minor = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05', name: 'Aziz Karimov' });
    const guardian = await makeUser(t, Role.GUARDIAN);
    const stranger = await makeUser(t, Role.GUARDIAN);
    await t.prisma.guardianLink.create({ data: { guardianId: guardian.id, studentId: minor.id, status: 'ACTIVE' } });
    const solo = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05', name: 'Solo Pupil' });
    const c2 = await mkClass(x);
    assert.equal((await api(t, solo.token).post('/classes/join', { code: c2.joinCode })).status, 200, 'a teen can join alone: a guardian is optional');
    assert.equal((await api(t, stranger.token).post('/classes/join', { code: c.joinCode, studentId: minor.id })).status, 404, 'not his child');
    assert.equal((await api(t, guardian.token).post('/classes/join', { code: c.joinCode })).status, 400, 'studentId required');
    const ok = await api(t, guardian.token).post('/classes/join', { code: c.joinCode, studentId: minor.id });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.mySeats, [minor.id]);
    assert.equal((await api(t, guardian.token).get('/classes/mine')).body[0].pupil.name, 'Aziz');
    assert.equal((await api(t, minor.token).get(`/classes/${c.id}`)).status, 200, 'the child can open his class');
    const adult = await makeUser(t);
    const g2 = await makeUser(t, Role.GUARDIAN);
    await t.prisma.guardianLink.create({ data: { guardianId: g2.id, studentId: adult.id, status: 'ACTIVE' } });
    assert.equal((await api(t, g2.token).post('/classes/join', { code: c.joinCode, studentId: adult.id })).status, 403, 'guardian for an adult');
    // blok
    const blocked = await makeUser(t);
    await t.prisma.userBlock.create({ data: { blockerId: x.user.id, blockedId: blocked.id } as any });
    assert.equal((await api(t, blocked.token).post('/classes/join', { code: c.joinCode })).status, 403);
    // o'qituvchi chiqarsa — qayta kira olmaydi
    const kicked = await makeUser(t);
    await api(t, kicked.token).post('/classes/join', { code: c.joinCode });
    assert.equal((await api(t, x.user.token).del(`/classes/${c.id}/pupils/${kicked.id}`)).status, 200);
    assert.equal((await api(t, kicked.token).get(`/classes/${c.id}`)).status, 404);
    const again = await api(t, kicked.token).post('/classes/join', { code: c.joinCode });
    assert.equal(again.status, 403);
    assert.equal(again.body.code, 'REMOVED');
    assert.equal((await t.prisma.class.findUniqueOrThrow({ where: { id: c.id } })).enrolledCount, 1 + 0 + 0, 'count follows removals');
  });

  it('visibility: pupils see classmates by first name only; strangers get 404; other teachers cannot touch the class', async () => {
    const x = await teacher();
    const other = await teacher();
    const c = await mkClass(x);
    const p1 = await makeUser(t, Role.STUDENT, { name: 'Ali Valiyev' });
    const p2 = await makeUser(t, Role.STUDENT, { name: 'Vali Karimov' });
    const outsider = await makeUser(t);
    for (const p of [p1, p2]) await api(t, p.token).post('/classes/join', { code: c.joinCode });
    const v = (await api(t, p1.token).get(`/classes/${c.id}`)).body;
    assert.deepEqual(v.classmates, [{ name: 'Vali' }]);
    const raw = JSON.stringify(v);
    for (const secret of [p2.id, p2.email, 'Karimov', x.user.email]) assert.ok(!raw.includes(secret), secret);
    const tv = (await api(t, x.user.token).get(`/classes/${c.id}`)).body;
    assert.equal(tv.pupils.length, 2);
    assert.equal(tv.pupils.find((p: any) => p.id === p2.id).name, 'Vali Karimov', 'the teacher sees full names');
    assert.equal((await api(t, outsider.token).get(`/classes/${c.id}`)).status, 404);
    assert.equal((await api(t, outsider.token).get(`/classes/${c.id}/sessions`)).status, 404);
    for (const r of [await api(t, other.user.token).get(`/classes/${c.id}`), await api(t, other.user.token).patch(`/classes/${c.id}`, { title: 'hijack' }), await api(t, other.user.token).post(`/classes/${c.id}/cancel`), await api(t, other.user.token).post(`/classes/${c.id}/regenerate-code`), await api(t, other.user.token).del(`/classes/${c.id}/pupils/${p1.id}`)]) assert.equal(r.status, 404);
    assert.equal((await api(t, p1.token).patch(`/classes/${c.id}`, { title: 'x' })).status, 403);
    const list = (await api(t, p1.token).get('/classes/mine')).body;
    assert.deepEqual(list.map((r: any) => r.id), [c.id]);
    assert.ok(!JSON.stringify(list).includes(p2.id));
  });

  it('teacher edit, capacity floor, regenerate code (old code stops working), cancel a session and the class notify pupils', async () => {
    const x = await teacher();
    const c = await mkClass(x, { capacity: 5 });
    const p = await makeUser(t);
    await api(t, p.token).post('/classes/join', { code: c.joinCode });
    assert.equal((await api(t, x.user.token).patch(`/classes/${c.id}`, { capacity: 0 })).status, 400);
    assert.equal((await api(t, x.user.token).patch(`/classes/${c.id}`, { title: 'Math 10', chatMode: 'QUESTIONS_ONLY' })).status, 200);
    const sess = (await api(t, x.user.token).get(`/classes/${c.id}/sessions`)).body;
    assert.equal((await t.prisma.classSession.findUniqueOrThrow({ where: { id: sess[0].id } })).chatMode, 'QUESTIONS_ONLY', 'future sessions follow the new default');
    const regen = (await api(t, x.user.token).post(`/classes/${c.id}/regenerate-code`)).body;
    const late = await makeUser(t);
    assert.equal((await api(t, late.token).post('/classes/join', { code: c.joinCode })).status, 404, 'old code is dead');
    assert.equal((await api(t, late.token).post('/classes/join', { code: regen.joinCode })).status, 200);
    assert.equal((await api(t, x.user.token).post(`/classes/${c.id}/sessions/${sess[0].id}/cancel`)).status, 200);
    assert.equal((await t.prisma.notification.count({ where: { userId: p.id, type: 'class.session_cancelled' } })), 1);
    assert.equal((await api(t, x.user.token).post(`/classes/${c.id}/cancel`)).status, 200);
    const n = await t.prisma.notification.findFirstOrThrow({ where: { userId: p.id, type: 'class.cancelled' } });
    assert.deepEqual(n.data, { classId: c.id }, 'push data carries ids only');
    assert.equal((await t.prisma.classSession.count({ where: { classId: c.id, status: { in: ['SCHEDULED', 'LOBBY'] } } })), 0);
    assert.equal((await api(t, (await makeUser(t)).token).post('/classes/join', { code: regen.joinCode })).status, 404, 'a cancelled class cannot be joined');
    assert.deepEqual((await api(t, p.token).get('/classes/mine')).body, []);
  });

  it('leave: pupil and guardian can leave, a stranger cannot make someone leave', async () => {
    const x = await teacher();
    const c = await mkClass(x);
    const p = await makeUser(t);
    const q = await makeUser(t);
    await api(t, p.token).post('/classes/join', { code: c.joinCode });
    await api(t, q.token).post('/classes/join', { code: c.joinCode });
    assert.equal((await api(t, q.token).post(`/classes/${c.id}/leave`, { studentId: p.id })).status, 404);
    assert.equal((await api(t, p.token).post(`/classes/${c.id}/leave`, {})).status, 200);
    assert.equal((await t.prisma.class.findUniqueOrThrow({ where: { id: c.id } })).enrolledCount, 1);
    assert.equal((await api(t, p.token).post('/classes/join', { code: c.joinCode })).status, 200, 'can rejoin after leaving');
  });
});
