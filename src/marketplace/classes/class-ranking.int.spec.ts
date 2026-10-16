import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { api, createTestApp, makeAdmin, makeTeacher, makeUser, TestApp } from '../testing/harness';
import { scoreOf } from './class-ranking.service';

describe('ranking formula (unit)', () => {
  it('weights attendance 50, homework 30, polls 20 and ignores parts that do not exist yet', () => {
    const full = { attendance: { done: 4, total: 4 }, homework: { done: 2, total: 2, avgScore: null }, polls: { done: 1, total: 1 }, bonus: 0 };
    assert.equal(scoreOf(full).total, 100);
    assert.equal(scoreOf({ ...full, attendance: { done: 2, total: 4 } }).base, 75);
    assert.equal(scoreOf({ ...full, homework: { done: 2, total: 2, avgScore: 50 } }).base, 92.5);
    assert.equal(scoreOf({ attendance: { done: 1, total: 2 }, homework: { done: 0, total: 0, avgScore: null }, polls: { done: 0, total: 0 }, bonus: 0 }).base, 50, 'only attendance exists: it is the whole score');
    assert.equal(scoreOf({ attendance: { done: 0, total: 0 }, homework: { done: 0, total: 0, avgScore: null }, polls: { done: 0, total: 0 }, bonus: 5 }).total, 5);
  });
});

describe('class ranking, bonuses, unread counters (integration)', () => {
  let t: TestApp;
  let admin: { id: string; token: string };
  before(async () => {
    t = await createTestApp();
    admin = await makeAdmin(t);
  });
  after(async () => {
    await t.close();
  });

  async function setup() {
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const c = (await api(t, x.user.token).post('/classes', { title: 'Math', subject: 'Math' })).body;
    const mk = async (name: string) => {
      const u = await makeUser(t, Role.STUDENT, { name });
      await t.prisma.user.update({ where: { id: u.id }, data: { username: `${name.split(' ')[0].toLowerCase()}_${Math.random().toString(36).slice(2, 6)}` } });
      assert.equal((await api(t, u.token).post('/classes/join', { code: c.joinCode })).status, 200);
      await t.prisma.classEnrollment.updateMany({ where: { classId: c.id, pupilId: u.id }, data: { createdAt: new Date(Date.now() - 20 * 86_400_000) } }); // joined long ago, so earlier lessons count
      return u;
    };
    const a = await mk('Aziz Tursunov');
    const b = await mk('Madina Ergasheva');
    const outsider = await makeUser(t, Role.STUDENT);
    const sessions: string[] = [];
    for (let i = 0; i < 4; i++) {
      const at = new Date(Date.now() + 3_600_000 - (i + 2) * 86_400_000);
      const s = await t.prisma.classSession.create({ data: { classId: c.id, startAt: at, endAt: new Date(at.getTime() + 3_600_000), status: 'ENDED', stageMode: 'HAND_RAISE', chatMode: 'OPEN', questionsMode: 'OPEN' } });
      sessions.push(s.id);
    }
    // Aziz attended 4 of 4, Madina 1 of 4
    for (const sid of sessions) await t.prisma.classAttendance.create({ data: { sessionId: sid, pupilId: a.id, firstJoinedAt: new Date(), totalSeconds: 3000 } });
    await t.prisma.classAttendance.create({ data: { sessionId: sessions[0], pupilId: b.id, firstJoinedAt: new Date(), totalSeconds: 3000 } });
    return { x, c, a, b, outsider };
  }

  it('ranks by attendance, shows percentages, hides nothing from the class but strangers get 404', async () => {
    const { x, c, a, b, outsider } = await setup();
    const r = (await api(t, b.token).get(`/classes/${c.id}/ranking`)).body;
    assert.deepEqual(r.items.map((i: any) => i.name), ['Aziz Tursunov', 'Madina Ergasheva']);
    assert.equal(r.items[0].rank, 1);
    assert.equal(r.items[0].attendance.percent, 100);
    assert.equal(r.items[1].attendance.percent, 25);
    assert.equal(r.items[1].mine, true);
    assert.equal(r.canGiveBonus, false);
    assert.equal((await api(t, outsider.token).get(`/classes/${c.id}/ranking`)).status, 404);
    assert.equal((await api(t, x.user.token).get(`/classes/${c.id}/ranking`)).body.canGiveBonus, true);
  });

  it('bonus points: only the teacher, 1..20, only for pupils of the class; they move the ranking', async () => {
    const { x, c, a, b, outsider } = await setup();
    const give = (token: string, pupilId: string, points: number) => api(t, token).post(`/classes/${c.id}/bonus`, { pupilId, points, note: 'Great work' });
    assert.equal((await give(b.token, b.id, 5)).status, 403, 'pupils cannot give bonuses');
    assert.equal((await give(x.user.token, b.id, 0)).status, 400);
    assert.equal((await give(x.user.token, b.id, 21)).status, 400);
    assert.equal((await give(x.user.token, outsider.id, 5)).status, 404);
    for (let i = 0; i < 6; i++) assert.equal((await give(x.user.token, b.id, 20)).status, 201);
    const r = (await api(t, x.user.token).get(`/classes/${c.id}/ranking`)).body.items;
    assert.equal(r[0].name, 'Madina Ergasheva', 'bonus lifted her above the pupil with perfect attendance');
    assert.equal(r[0].bonus, 120);
  });

  it('a minor is shown by first name and initial; username, photo and id only to the teacher', async () => {
    const { x, c, a } = await setup();
    const g = await makeUser(t, Role.GUARDIAN);
    const kid = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05', name: 'Kid Karimov' });
    await t.prisma.user.update({ where: { id: kid.id }, data: { username: `kidk_${Math.random().toString(36).slice(2, 6)}` } });
    await t.prisma.guardianLink.create({ data: { guardianId: g.id, studentId: kid.id, status: 'ACTIVE' } });
    const me = await api(t, x.user.token).get(`/classes/${c.id}`);
    assert.equal((await api(t, g.token).post('/classes/join', { code: (await api(t, x.user.token).post(`/classes/${c.id}/regenerate-code`)).body.joinCode, studentId: kid.id })).status, 200);
    void me;
    const forPupil = (await api(t, a.token).get(`/classes/${c.id}/ranking`)).body.items.find((i: any) => i.name === 'Kid K.');
    assert.ok(forPupil);
    assert.equal(forPupil.username, null);
    assert.equal(forPupil.userId, null);
    const forTeacher = (await api(t, x.user.token).get(`/classes/${c.id}/ranking`)).body.items.find((i: any) => i.name === 'Kid K.');
    assert.ok(forTeacher.username);
    assert.equal(forTeacher.userId, kid.id);
  });

  it('channel: authors carry @username for adults; unread counters are real and reset when the channel is opened', async () => {
    const { x, c, a, b } = await setup();
    const base = `/classes/${c.id}/channel`;
    assert.equal((await api(t, x.user.token).post(base, { body: 'Hello class' })).status, 201);
    assert.equal((await api(t, a.token).post(base, { body: 'Hi teacher' })).status, 201);
    const u0 = (await api(t, b.token).get('/me/unread')).body;
    assert.equal(u0.channels, 2);
    assert.equal(u0.byClass[c.id], 2);
    assert.equal(u0.total, 2 + u0.messages);
    const list = (await api(t, b.token).get(base)).body.items;
    const az = list.find((m: any) => m.body === 'Hi teacher').author;
    assert.ok(az.username && az.id === a.id);
    assert.equal((await api(t, b.token).get('/me/unread')).body.channels, 0, 'opening the channel marks it as read');
    assert.equal((await api(t, a.token).get('/me/unread')).body.channels, 0, 'writing in the channel counts as having read it');
  });
});
