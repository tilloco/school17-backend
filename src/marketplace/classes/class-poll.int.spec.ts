import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { ClockService } from '../common/clock';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makeTeacher, makeUser, TestApp, TestUser } from '../testing/harness';

const START = '2026-11-05T10:00:00.000Z';
const at = (m: number) => new Date(new Date(START).getTime() + m * 60_000);

describe('live polls (R9, integration)', () => {
  let t: TestApp;
  let clock: ClockService;
  let admin: { id: string; token: string };

  async function live(n = 4, minor = false) {
    clock.set(new Date('2026-11-02T00:00:00Z'));
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const c = (await api(t, x.user.token).post('/classes', { title: 'Math', subject: 'Math', capacity: 30, oneOffStartAt: START })).body;
    const ps: TestUser[] = [];
    for (let i = 0; i < n; i++) {
      const u = await makeUser(t, Role.STUDENT);
      await api(t, u.token).post('/classes/join', { code: c.joinCode });
      ps.push(u);
    }
    if (minor) {
      const g = await makeUser(t, Role.GUARDIAN);
      const m = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05' });
      await t.prisma.guardianLink.create({ data: { guardianId: g.id, studentId: m.id, status: 'ACTIVE' } });
      await api(t, g.token).post('/classes/join', { code: c.joinCode, studentId: m.id });
    }
    const sid = (await api(t, x.user.token).get(`/classes/${c.id}/sessions`)).body[0].id as string;
    clock.set(at(-5));
    await api(t, x.user.token).post(`/class-sessions/${sid}/start`);
    return { x, c, ps, sid, base: `/class-sessions/${sid}/polls` };
  }

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
    const p = `/class-sessions/${id}/polls`;
    const failures = await checkRouteMatrix(t, actors, [
      { method: 'POST', path: p, body: { question: 'q', options: ['a', 'b'] }, allowed: ['TEACHER'] },
      { method: 'GET', path: `${p}/current`, allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'GET', path: p, allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'POST', path: `${p}/${id}/close`, allowed: ['TEACHER'] },
      { method: 'POST', path: `${p}/${id}/vote`, body: { option: 0 }, allowed: ['STUDENT', 'GUARDIAN'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('one open poll at a time (also under parallel requests); 2-6 options; teacher only; live only', async () => {
    const { x, ps, base, sid } = await live(2);
    assert.equal((await api(t, ps[0].token).post(base, { question: 'q?', options: ['a', 'b'] })).status, 403);
    for (const bad of [{ question: 'q?', options: ['only one'] }, { question: 'q?', options: ['a', 'a'] }, { question: 'q?', options: ['1', '2', '3', '4', '5', '6', '7'] }, { question: '', options: ['a', 'b'] }, { question: 'q?', options: ['a', ' '] }, { question: 'q?'.padEnd(201, 'x'), options: ['a', 'b'] }, { question: 'q?', options: ['a', 'b'.repeat(101)] }]) {
      assert.equal((await api(t, x.user.token).post(base, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
    }
    const res = await Promise.all([1, 2, 3, 4].map((i) => api(t, x.user.token).post(base, { question: `Parallel ${i}?`, options: ['yes', 'no'] })));
    assert.equal(res.filter((r) => r.status === 201).length, 1, 'exactly one poll opens');
    assert.deepEqual([...new Set(res.filter((r) => r.status !== 201).map((r) => r.body.code))], ['POLL_OPEN']);
    assert.equal(await t.prisma.classPoll.count({ where: { sessionId: sid, status: 'OPEN' } }), 1);
    await api(t, x.user.token).post(`/class-sessions/${sid}/end`);
    assert.equal((await api(t, x.user.token).post(base, { question: 'late?', options: ['a', 'b'] })).body.code, 'NOT_LIVE');
    const other = await makeTeacher(t, { approve: { adminToken: admin.token } });
    assert.equal((await api(t, other.user.token).post(base, { question: 'q?', options: ['a', 'b'] })).status, 404);
  });

  it('voting: once per pupil through the backend, counts live for the teacher only, results for everyone after closing; nobody sees who voted what', async () => {
    const { x, ps, base } = await live(4);
    const poll = (await api(t, x.user.token).post(base, { question: 'Which topic next?', options: ['Limits', 'Derivatives', 'Integrals'] })).body;
    assert.equal(poll.status, 'OPEN');
    assert.deepEqual(poll.options.map((o: any) => o.votes), [0, 0, 0]);
    const cur = (await api(t, ps[0].token).get(`${base}/current`)).body;
    assert.equal(cur.question, 'Which topic next?');
    assert.equal(cur.options[0].votes, undefined, 'pupils see no counts while it is open');
    assert.equal(cur.total, undefined);
    const vote = (u: TestUser, option: number) => api(t, u.token).post(`${base}/${poll.id}/vote`, { option });
    assert.equal((await vote(ps[0], 1)).status, 200);
    const again = await vote(ps[0], 2);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'ALREADY_VOTED');
    assert.equal((await vote(ps[1], 1)).status, 200);
    assert.equal((await vote(ps[2], 0)).status, 200);
    assert.equal((await vote(ps[3], 9)).status, 400);
    assert.equal((await vote(ps[3], -1)).status, 400);
    assert.equal((await api(t, x.user.token).post(`${base}/${poll.id}/vote`, { option: 0 })).status, 403, 'the teacher does not vote');
    assert.equal((await api(t, (await makeUser(t)).token).post(`${base}/${poll.id}/vote`, { option: 0 })).status, 404, 'not in this class');
    const live_ = (await api(t, x.user.token).get(`${base}/current`)).body;
    assert.deepEqual(live_.options.map((o: any) => o.votes), [1, 2, 0]);
    assert.equal(live_.total, 3);
    assert.equal((await api(t, ps[0].token).get(`${base}/current`)).body.myVote, 1);
    const raw = JSON.stringify(live_);
    for (const s of [ps[0].id, ps[1].id, ps[0].email]) assert.ok(!raw.includes(s), 'no voter identity');
    assert.deepEqual((await api(t, ps[0].token).get(base)).body, [], 'open polls are not in the pupil history');
    // yopish
    assert.equal((await api(t, ps[0].token).post(`${base}/${poll.id}/close`)).status, 403);
    const closed = await api(t, x.user.token).post(`${base}/${poll.id}/close`);
    assert.equal(closed.body.status, 'CLOSED');
    assert.equal((await vote(ps[3], 0)).body.code, 'POLL_CLOSED');
    const res = (await api(t, ps[3].token).get(`${base}/current`)).body;
    assert.deepEqual(res.options.map((o: any) => o.votes), [1, 2, 0], 'results for everyone once closed');
    assert.equal(res.total, 3);
    // yangi so'rovnoma ochish mumkin
    assert.equal((await api(t, x.user.token).post(base, { question: 'Second?', options: ['a', 'b'] })).status, 201);
    assert.equal((await api(t, x.user.token).get(base)).body.length, 2);
  });

  it('abuse guards: removed pupils cannot vote; contact details are refused in a class with minors; the vote endpoint is rate limited', async () => {
    const { x, ps, base, sid } = await live(2, true);
    const poll = (await api(t, x.user.token).post(base, { question: 'Choose', options: ['a', 'b'] })).body;
    assert.equal((await api(t, x.user.token).post(`/class-sessions/${sid}/remove`, { pupilId: ps[1].id })).status, 200);
    assert.equal((await api(t, ps[1].token).post(`${base}/${poll.id}/vote`, { option: 0 })).body.code, 'REMOVED_FROM_SESSION');
    await api(t, x.user.token).post(`${base}/${poll.id}/close`);
    const bad = await api(t, x.user.token).post(base, { question: 'Text me at +998 90 123 45 67', options: ['a', 'b'] });
    assert.equal(bad.body.code, 'CONTACT_INFO_NOT_ALLOWED');
    const th = await createTestApp([], { throttle: true });
    try {
      const c2 = th.app.get(ClockService);
      c2.set(new Date('2026-11-02T00:00:00Z'));
      const a2 = await makeAdmin(th);
      const x2 = await makeTeacher(th, { approve: { adminToken: a2.token } });
      const cl = (await api(th, x2.user.token).post('/classes', { title: 'Math', subject: 'Math', capacity: 5, oneOffStartAt: START })).body;
      const p2 = await makeUser(th);
      await api(th, p2.token).post('/classes/join', { code: cl.joinCode });
      const sid2 = (await api(th, x2.user.token).get(`/classes/${cl.id}/sessions`)).body[0].id;
      c2.set(at(-5));
      await api(th, x2.user.token).post(`/class-sessions/${sid2}/start`);
      const pl = (await api(th, x2.user.token).post(`/class-sessions/${sid2}/polls`, { question: 'q?', options: ['a', 'b'] })).body;
      const codes: number[] = [];
      for (let i = 0; i < 20; i++) codes.push((await api(th, p2.token).post(`/class-sessions/${sid2}/polls/${pl.id}/vote`, { option: 0 })).status);
      assert.ok(codes.includes(429), codes.join(','));
      c2.set(null);
    } finally {
      await th.close();
    }
  });

  it('results are saved to the recap; a poll still open when the class ends is closed and counted', async () => {
    const { x, ps, base, sid } = await live(3);
    const p1 = (await api(t, x.user.token).post(base, { question: 'First?', options: ['yes', 'no'] })).body;
    await api(t, ps[0].token).post(`${base}/${p1.id}/vote`, { option: 0 });
    await api(t, ps[1].token).post(`${base}/${p1.id}/vote`, { option: 0 });
    await api(t, x.user.token).post(`${base}/${p1.id}/close`);
    const p2 = (await api(t, x.user.token).post(base, { question: 'Second?', options: ['red', 'blue'] })).body;
    await api(t, ps[2].token).post(`${base}/${p2.id}/vote`, { option: 1 });
    clock.set(at(30));
    await api(t, x.user.token).post(`/class-sessions/${sid}/end`);
    const recap = (await api(t, x.user.token).get(`/class-sessions/${sid}/recap`)).body;
    assert.equal(recap.polls.length, 2);
    assert.deepEqual(recap.polls[0].options, [{ text: 'yes', votes: 2 }, { text: 'no', votes: 0 }]);
    assert.deepEqual(recap.polls[1].options, [{ text: 'red', votes: 0 }, { text: 'blue', votes: 1 }]);
    assert.equal((await t.prisma.classPoll.findUniqueOrThrow({ where: { id: p2.id } })).status, 'CLOSED');
    const pupilRecap = (await api(t, ps[0].token).get(`/class-sessions/${sid}/recap`)).body;
    assert.equal(pupilRecap.polls.length, 2);
    assert.ok(!JSON.stringify(pupilRecap).includes(ps[1].id));
  });
});
