import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { CALL_PROVIDER } from '../calls/call-provider';
import { MockCallProvider } from '../calls/mock-provider';
import { ClockService } from '../common/clock';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makeTeacher, makeUser, TestApp, TestUser } from '../testing/harness';
import { classRoomName } from './class-room.service';

const START = '2026-11-05T10:00:00.000Z';
const at = (offsetMin: number) => new Date(new Date(START).getTime() + offsetMin * 60_000);

describe('class chat and questions (R3, integration)', () => {
  let t: TestApp;
  let clock: ClockService;
  let mock: MockCallProvider;
  let admin: { id: string; token: string };

  async function live(n = 3, opts: { minor?: boolean } = {}) {
    clock.set(new Date('2026-11-02T00:00:00Z'));
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const c = (await api(t, x.user.token).post('/classes', { title: 'Math', subject: 'Math', capacity: 30, oneOffStartAt: START })).body;
    const pupils: TestUser[] = [];
    for (let i = 0; i < n; i++) {
      const u = await makeUser(t, Role.STUDENT, { name: `Pupil${i} Family${i}` });
      await api(t, u.token).post('/classes/join', { code: c.joinCode });
      pupils.push(u);
    }
    if (opts.minor) {
      const g = await makeUser(t, Role.GUARDIAN);
      const m = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05', name: 'Aziz Karimov' });
      await t.prisma.guardianLink.create({ data: { guardianId: g.id, studentId: m.id, status: 'ACTIVE' } });
      assert.equal((await api(t, g.token).post('/classes/join', { code: c.joinCode, studentId: m.id })).status, 200);
    }
    const sid = (await api(t, x.user.token).get(`/classes/${c.id}/sessions`)).body[0].id as string;
    clock.set(at(-5));
    await api(t, x.user.token).post(`/class-sessions/${sid}/start`);
    return { x, c, sid, pupils, base: `/class-sessions/${sid}` };
  }

  before(async () => {
    t = await createTestApp();
    clock = t.app.get(ClockService);
    mock = t.app.get(CALL_PROVIDER) as MockCallProvider;
    admin = await makeAdmin(t);
  });
  after(async () => {
    clock.set(null);
    await t.close();
  });

  it('route matrix', async () => {
    const actors = { STUDENT: await makeUser(t, Role.STUDENT), GUARDIAN: await makeUser(t, Role.GUARDIAN), TEACHER: (await makeTeacher(t, { approve: { adminToken: admin.token } })).user, adminToken: admin.token };
    const id = '11111111-1111-4111-8111-111111111111';
    const p = `/class-sessions/${id}`;
    const failures = await checkRouteMatrix(t, actors, [
      { method: 'GET', path: `${p}/messages`, allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'POST', path: `${p}/messages`, body: { body: 'hi' }, allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'DELETE', path: `${p}/messages/${id}`, allowed: ['TEACHER'] },
      { method: 'GET', path: `${p}/questions`, allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'POST', path: `${p}/questions`, body: { text: 'why?' }, allowed: ['STUDENT', 'GUARDIAN'] },
      { method: 'POST', path: `${p}/questions/${id}/upvote`, allowed: ['STUDENT', 'GUARDIAN'] },
      { method: 'POST', path: `${p}/questions/${id}/answer`, body: {}, allowed: ['TEACHER'] },
      { method: 'POST', path: `${p}/questions/${id}/later`, allowed: ['TEACHER'] },
      { method: 'POST', path: `${p}/questions/${id}/hide`, allowed: ['TEACHER'] },
      { method: 'POST', path: `${p}/questions/${id}/pin`, body: { pinned: true }, allowed: ['TEACHER'] },
      { method: 'POST', path: `${p}/questions/${id}/call`, allowed: ['TEACHER'] },
      { method: 'POST', path: `${p}/settings`, body: {}, allowed: ['TEACHER'] },
      { method: 'POST', path: `${p}/mute-chat`, body: { pupilId: id, minutes: 5 }, allowed: ['TEACHER'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('chat: first names, resume after a seq, only participants, not before the lobby, length limit', async () => {
    const { x, pupils, base, c } = await live(2);
    const outsider = await makeUser(t);
    const m1 = await api(t, pupils[0].token).post(`${base}/messages`, { body: 'Hello everyone' });
    assert.equal(m1.status, 201, JSON.stringify(m1.body));
    assert.equal(m1.body.name, 'Pupil0');
    const m2 = await api(t, x.user.token).post(`${base}/messages`, { body: 'Welcome' });
    assert.equal(m2.body.from, 'teacher');
    const all = (await api(t, pupils[1].token).get(`${base}/messages`)).body;
    assert.deepEqual(all.map((m: any) => m.body), ['Hello everyone', 'Welcome']);
    assert.ok(!JSON.stringify(all).includes('Family0') && !JSON.stringify(all).includes(pupils[0].email));
    const resumed = (await api(t, pupils[1].token).get(`${base}/messages?after=${all[0].seq}`)).body;
    assert.deepEqual(resumed.map((m: any) => m.body), ['Welcome'], 'resume from the last seen id');
    assert.equal((await api(t, outsider.token).get(`${base}/messages`)).status, 404);
    assert.equal((await api(t, outsider.token).post(`${base}/messages`, { body: 'x' })).status, 404);
    clock.set(at(-4));
    assert.equal((await api(t, pupils[0].token).post(`${base}/messages`, { body: 'x'.repeat(501) })).status, 400);
    assert.equal((await api(t, pupils[0].token).post(`${base}/messages`, { body: '   ' })).status, 400);
    // boshlanmagan sessiya (boshqa sinf, hali SCHEDULED)
    clock.set(new Date('2026-11-02T00:00:00Z'));
    const sid2 = (await api(t, x.user.token).get(`/classes/${c.id}/sessions`)).body[0].id;
    assert.equal(sid2, base.split('/')[2]);
  });

  it('chat limits: 1 message per 2 s, slow mode, chat modes, mute for N minutes, delete by the teacher only', async () => {
    const { x, pupils, base } = await live(3);
    const [a, b, c] = pupils;
    clock.set(at(-4));
    assert.equal((await api(t, a.token).post(`${base}/messages`, { body: 'one' })).status, 201);
    const fast = await api(t, a.token).post(`${base}/messages`, { body: 'two' });
    assert.equal(fast.status, 429);
    assert.equal(fast.body.code, 'RATE_LIMIT');
    clock.set(new Date(at(-4).getTime() + 2100));
    assert.equal((await api(t, a.token).post(`${base}/messages`, { body: 'two' })).status, 201);
    // sekin rejim
    assert.equal((await api(t, x.user.token).post(`${base}/settings`, { slowModeSeconds: 30 })).status, 200);
    clock.set(new Date(at(-4).getTime() + 10_000));
    const slow = await api(t, a.token).post(`${base}/messages`, { body: 'three' });
    assert.equal(slow.body.code, 'SLOW_MODE');
    assert.equal((await api(t, x.user.token).post(`${base}/messages`, { body: 'teacher is exempt' })).status, 201);
    assert.equal((await api(t, a.token).post(`${base}/settings`, { slowModeSeconds: 0 })).status, 403, 'a pupil cannot change settings');
    assert.equal((await api(t, x.user.token).post(`${base}/settings`, { slowModeSeconds: 9999 })).status, 400);
    await api(t, x.user.token).post(`${base}/settings`, { slowModeSeconds: 0 });
    // rejimlar
    await api(t, x.user.token).post(`${base}/settings`, { chatMode: 'QUESTIONS_ONLY' });
    assert.equal((await api(t, b.token).post(`${base}/messages`, { body: 'hi' })).body.code, 'CHAT_QUESTIONS_ONLY');
    await api(t, x.user.token).post(`${base}/settings`, { chatMode: 'OFF' });
    assert.equal((await api(t, b.token).post(`${base}/messages`, { body: 'hi' })).body.code, 'CHAT_OFF');
    assert.equal((await api(t, x.user.token).post(`${base}/messages`, { body: 'teacher can still write' })).status, 201);
    await api(t, x.user.token).post(`${base}/settings`, { chatMode: 'OPEN' });
    // vaqtincha ovozsiz
    assert.equal((await api(t, x.user.token).post(`${base}/mute-chat`, { pupilId: c.id, minutes: 5 })).status, 200);
    assert.equal((await api(t, c.token).post(`${base}/messages`, { body: 'hi' })).body.code, 'MUTED');
    assert.equal((await api(t, c.token).post(`${base}/questions`, { text: 'why?' })).body.code, 'MUTED', 'questions are muted too');
    assert.equal((await api(t, b.token).post(`${base}/mute-chat`, { pupilId: c.id, minutes: 5 })).status, 403);
    clock.set(new Date(at(-4).getTime() + 6 * 60_000));
    assert.equal((await api(t, c.token).post(`${base}/messages`, { body: 'back' })).status, 201, 'mute expired');
    // o'chirish
    const msgs = (await api(t, x.user.token).get(`${base}/messages`)).body;
    const target = msgs.find((m: any) => m.body === 'back');
    assert.equal((await api(t, c.token).del(`${base}/messages/${target.id}`)).status, 403);
    assert.equal((await api(t, x.user.token).del(`${base}/messages/${target.id}`)).status, 200);
    const after_ = (await api(t, b.token).get(`${base}/messages`)).body.find((m: any) => m.id === target.id);
    assert.equal(after_.deleted, true);
    assert.equal(after_.body, null);
  });

  it('contact details are blocked when the class has pupils under 18 (chat, questions, teacher replies)', async () => {
    const { x, pupils, base } = await live(1, { minor: true });
    clock.set(at(-4));
    const r = await api(t, pupils[0].token).post(`${base}/messages`, { body: 'call me on +998 90 123 45 67' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'CONTACT_INFO_NOT_ALLOWED');
    assert.equal((await api(t, x.user.token).post(`${base}/messages`, { body: 'write to me at teacher@example.com' })).status, 400);
    assert.equal((await api(t, pupils[0].token).post(`${base}/questions`, { text: 'my telegram is @someone_here, ok?' })).status, 400);
    assert.equal((await api(t, pupils[0].token).post(`${base}/messages`, { body: 'normal message' })).status, 201);
  });

  it('questions: anonymity, one upvote per pupil, ordering, teacher actions, hidden ones vanish, rate limit 3/min', async () => {
    const { x, pupils, base } = await live(4);
    const [a, b, c, d] = pupils;
    clock.set(at(-4));
    const q1 = (await api(t, a.token).post(`${base}/questions`, { text: 'What is a derivative?' })).body;
    clock.set(at(-3));
    const q2 = (await api(t, b.token).post(`${base}/questions`, { text: 'Can we repeat limits?', anonymous: true })).body;
    assert.equal(q1.author, 'Pupil0');
    assert.equal(q2.author, 'Pupil1', 'the author still sees his own name');
    const seenByC = (await api(t, c.token).get(`${base}/questions`)).body;
    assert.equal(seenByC.find((q: any) => q.id === q2.id).author, null, 'classmates do not see an anonymous author');
    assert.ok(!JSON.stringify(seenByC).includes(b.id), 'no author id for pupils');
    const seenByTeacher = (await api(t, x.user.token).get(`${base}/questions`)).body;
    assert.equal(seenByTeacher.find((q: any) => q.id === q2.id).author, 'Pupil1', 'the teacher always sees the name');
    assert.equal(seenByTeacher.find((q: any) => q.id === q2.id).authorId, b.id);
    // ovozlar
    assert.equal((await api(t, c.token).post(`${base}/questions/${q2.id}/upvote`)).body.upvotes, 1);
    const dup = await api(t, c.token).post(`${base}/questions/${q2.id}/upvote`);
    assert.equal(dup.status, 409);
    assert.equal(dup.body.code, 'ALREADY_VOTED');
    await api(t, d.token).post(`${base}/questions/${q2.id}/upvote`);
    let list = (await api(t, c.token).get(`${base}/questions`)).body;
    assert.deepEqual(list.map((q: any) => q.id), [q2.id, q1.id], 'more votes first');
    assert.equal(list[0].voted, true);
    // yopishtirish ustun
    assert.equal((await api(t, x.user.token).post(`${base}/questions/${q1.id}/pin`, { pinned: true })).status, 200);
    list = (await api(t, c.token).get(`${base}/questions`)).body;
    assert.deepEqual(list.map((q: any) => q.id), [q1.id, q2.id], 'pinned first');
    // o'quvchi o'qituvchi amallarini bajara olmaydi
    for (const [path, body] of [['answer', {}], ['later', {}], ['hide', {}], ['pin', { pinned: true }], ['call', {}]] as const) assert.equal((await api(t, c.token).post(`${base}/questions/${q1.id}/${path}`, body)).status, 403, path);
    assert.equal((await api(t, x.user.token).post(`${base}/questions`, { text: 'teacher asks?' })).status, 403);
    // javob, keyinroq, yashirish
    assert.equal((await api(t, x.user.token).post(`${base}/questions/${q1.id}/answer`, { reply: 'It is the rate of change.' })).status, 200);
    const answered = (await api(t, c.token).get(`${base}/questions`)).body.find((q: any) => q.id === q1.id);
    assert.equal(answered.status, 'ANSWERED');
    assert.equal(answered.reply.text, 'It is the rate of change.');
    assert.equal((await api(t, x.user.token).post(`${base}/questions/${q2.id}/later`)).status, 200);
    assert.equal((await api(t, c.token).get(`${base}/questions`)).body.find((q: any) => q.id === q2.id).status, 'LATER');
    assert.equal((await api(t, x.user.token).post(`${base}/questions/${q2.id}/hide`)).status, 200);
    assert.equal((await api(t, c.token).get(`${base}/questions`)).body.some((q: any) => q.id === q2.id), false, 'hidden from pupils');
    assert.equal((await api(t, x.user.token).get(`${base}/questions`)).body.some((q: any) => q.id === q2.id), true, 'the teacher still sees it');
    assert.equal((await api(t, c.token).post(`${base}/questions/${q2.id}/upvote`)).status, 404);
    // chaqirish = ovoz berish
    const q3 = (await api(t, d.token).post(`${base}/questions`, { text: 'May I explain?' })).body;
    assert.equal((await api(t, x.user.token).post(`${base}/questions/${q3.id}/call`)).body.pupilId, d.id);
    const sid = base.split('/')[2];
    assert.deepEqual(mock.permissions.get(`${classRoomName(sid)}|${d.id}`), { canPublish: true, publishSources: ['microphone'] });
    // chegara: daqiqasiga 3 ta
    const spammer = pupils[2];
    clock.set(at(-1));
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await api(t, spammer.token).post(`${base}/questions`, { text: `question ${i}?` })).status);
    assert.deepEqual(codes, [201, 201, 201, 429, 429]);
    clock.set(new Date(at(-1).getTime() + 61_000));
    assert.equal((await api(t, spammer.token).post(`${base}/questions`, { text: 'again?' })).status, 201);
    // savollar o'chirilgan
    await api(t, x.user.token).post(`${base}/settings`, { questionsMode: 'OFF' });
    assert.equal((await api(t, a.token).post(`${base}/questions`, { text: 'late one?' })).body.code, 'QUESTIONS_OFF');
  });

  it('reporting: a pupil can report a classmate message or a pupil; duplicates, own messages and outsiders are refused; the report keeps context', async () => {
    const { x, pupils, base } = await live(2);
    const [a, b] = pupils;
    const outsider = await makeUser(t);
    clock.set(at(-4));
    const m = (await api(t, a.token).post(`${base}/messages`, { body: 'you are all stupid' })).body;
    const rep = await api(t, b.token).post(`${base}/messages/${m.id}/report`, { reason: 'ABUSE', note: 'rude' });
    assert.equal(rep.status, 201, JSON.stringify(rep.body));
    const row = await t.prisma.report.findUniqueOrThrow({ where: { id: rep.body.id } });
    assert.equal(row.targetType, 'MESSAGE');
    assert.equal((row.snapshot as any).reportedUserId, a.id);
    assert.equal((row.snapshot as any).context.at(-1).body, 'you are all stupid');
    assert.equal((await api(t, b.token).post(`${base}/messages/${m.id}/report`, { reason: 'ABUSE' })).status, 409);
    assert.equal((await api(t, a.token).post(`${base}/messages/${m.id}/report`, { reason: 'ABUSE' })).status, 403, 'own message');
    assert.equal((await api(t, outsider.token).post(`${base}/messages/${m.id}/report`, { reason: 'ABUSE' })).status, 404);
    assert.equal((await api(t, b.token).post(`${base}/report-pupil`, { pupilId: a.id, reason: 'ABUSE' })).status, 201);
    assert.equal((await api(t, b.token).post(`${base}/report-pupil`, { pupilId: outsider.id, reason: 'ABUSE' })).status, 404);
    assert.equal((await api(t, x.user.token).post(`${base}/report-pupil`, { pupilId: b.id, reason: 'SPAM' })).status, 201, 'the teacher can report too');
  });
});
