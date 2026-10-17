import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { api, createTestApp, makeAdmin, makeJpeg, makeTeacher, makeUser, TestApp, uploadFile } from '../testing/harness';

describe('direct messages, avatars, class reviews and comment reports (integration)', () => {
  let t: TestApp;
  let admin: { id: string; token: string };
  before(async () => {
    t = await createTestApp();
    admin = await makeAdmin(t);
  });
  after(async () => {
    await t.close();
  });

  const uname = (p: string) => `${p}_${Math.random().toString(36).slice(2, 8)}`;
  async function named(role: Role, p: string, opts: { dateOfBirth?: string; name?: string } = {}) {
    const u = await makeUser(t, role, opts);
    const username = uname(p);
    await t.prisma.user.update({ where: { id: u.id }, data: { username } });
    return { ...u, username };
  }
  async function classWith(...pupils: { token: string }[]) {
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const c = (await api(t, x.user.token).post('/classes', { title: 'Math', subject: 'Math' })).body;
    for (const p of pupils) assert.equal((await api(t, p.token).post('/classes/join', { code: c.joinCode })).status, 200);
    return { x, c };
  }

  it('classmates and their teacher can message without a booking; strangers in other classes cannot (no username = not findable)', async () => {
    const a = await named(Role.STUDENT, 'aziz');
    const b = await makeUser(t, Role.STUDENT); // no username
    const out = await makeUser(t, Role.STUDENT);
    const { x } = await classWith(a, b);
    const open = await api(t, a.token).post('/threads/direct', { userId: b.id });
    assert.equal(open.status, 200, JSON.stringify(open.body));
    assert.equal(open.body.status, 'ACTIVE');
    assert.equal((await api(t, a.token).post(`/threads/${open.body.id}/messages`, { body: 'Hi, what is the homework?' })).status, 201);
    const bList = (await api(t, b.token).get('/threads')).body;
    assert.equal(bList.find((v: any) => v.id === open.body.id).unread, 1);
    assert.equal((await api(t, b.token).post('/threads/direct', { userId: a.id })).body.id, open.body.id, 'one thread for both directions');
    assert.equal((await api(t, x.user.token).post('/threads/direct', { userId: a.id })).status, 200, 'teacher to own pupil');
    assert.equal((await api(t, out.token).post('/threads/direct', { userId: b.id })).status, 404, 'a stranger without a username cannot be contacted');
    const contacts = (await api(t, a.token).get('/threads/contacts')).body;
    assert.deepEqual(contacts.map((c: any) => c.userId).sort(), [b.id, x.user.id].sort());
  });

  it('"message requests" switch: off by default; when on, classmates land in requests but the teacher still gets through directly', async () => {
    const a = await named(Role.STUDENT, 'anvar');
    const b = await named(Role.STUDENT, 'bobur');
    const { x } = await classWith(a, b);
    assert.equal((await api(t, b.token).get('/me')).body.dmRequests, false);
    assert.equal((await api(t, b.token).patch('/me', { dmRequests: true })).status, 200);
    assert.equal((await api(t, b.token).get('/me')).body.dmRequests, true);
    const open = await api(t, a.token).post('/threads/direct', { userId: b.id });
    assert.equal(open.body.status, 'REQUEST');
    const teacher = await api(t, x.user.token).post('/threads/direct', { userId: b.id });
    assert.equal(teacher.body.status, 'ACTIVE', 'teacher is never filtered');
  });

  it('username check: taken names (any letter case) are rejected, free ones pass', async () => {
    const a = await named(Role.STUDENT, 'karim');
    const b = await makeUser(t, Role.STUDENT);
    const chk = async (u: string) => (await api(t, b.token).get(`/me/username-check?u=${encodeURIComponent(u)}`)).body;
    assert.deepEqual(await chk(a.username.toUpperCase()), { ok: false, reason: 'TAKEN' });
    assert.equal((await chk('ab')).ok, false);
    assert.equal((await chk(uname('free'))).ok, true);
    assert.equal((await api(t, b.token).patch('/me', { username: a.username.toUpperCase() })).status, 409);
  });

  it('friends from contacts: hashes of phone numbers find people (teens included); opt-out, blocked and unknown stay hidden', async () => {
    const { createHash } = require('node:crypto');
    const h = (n: string) => createHash('sha256').update(n).digest('hex');
    const me = await makeUser(t, Role.STUDENT);
    const a = await named(Role.STUDENT, 'dilnoza');
    const kid = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05' });
    const hidden = await makeUser(t, Role.STUDENT);
    const num = (i: number) => `+99890${String(Date.now() % 10000000).padStart(7, '0').slice(0, 6)}${i}`;
    const [pa, pk, ph] = [num(1), num(2), num(3)];
    await t.prisma.user.update({ where: { id: a.id }, data: { phone: pa, phoneHash: h(pa) } });
    await t.prisma.user.update({ where: { id: kid.id }, data: { phone: pk, phoneHash: h(pk) } });
    await t.prisma.user.update({ where: { id: hidden.id }, data: { phone: ph, phoneHash: h(ph), phoneDiscoverable: false } });
    const res = await api(t, me.token).post('/threads/people-from-contacts', { hashes: [h(pa), h(pk), h(ph), h('+998000000000')] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.map((x: any) => x.userId).sort(), [a.id, kid.id].sort());
    assert.equal((await api(t, me.token).post('/threads/people-from-contacts', { hashes: ['+998901234567'] })).status, 400, 'raw numbers are refused: only hashes');
    await t.prisma.userBlock.create({ data: { blockerId: me.id, blockedId: a.id } });
    const after = await api(t, me.token).post('/threads/people-from-contacts', { hashes: [h(pa)] });
    assert.equal(after.body.length, 0);
  });

  it('replies in ordinary chats: a message can quote another one of the same chat; quotes of deleted messages are blank; other chats are refused', async () => {
    const a = await named(Role.STUDENT, 'reply_a');
    const b = await named(Role.STUDENT, 'reply_b');
    const { x } = await classWith(a, b);
    const th = (await api(t, a.token).post('/threads/direct', { userId: b.id })).body.id;
    const q = (await api(t, a.token).post(`/threads/${th}/messages`, { body: 'Uy vazifasi nima edi?' })).body;
    const r = await api(t, b.token).post(`/threads/${th}/messages`, { body: '5-mashq', replyToId: q.id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.replyTo.id, q.id);
    assert.equal(r.body.replyTo.body, 'Uy vazifasi nima edi?');
    assert.equal(r.body.replyTo.mine, false);
    const list = (await api(t, a.token).get(`/threads/${th}/messages`)).body;
    assert.equal(list[1].replyTo.mine, true, 'the quote knows whose message it was for the reader');
    const other = (await api(t, a.token).post('/threads/direct', { userId: x.user.id })).body.id;
    const foreign = (await api(t, a.token).post(`/threads/${other}/messages`, { body: 'salom' })).body.id;
    assert.equal((await api(t, b.token).post(`/threads/${th}/messages`, { body: 'x', replyToId: foreign })).status, 404);
  });

  it('message request: one message until accepted; replying accepts; declining stops it', async () => {
    const a = await named(Role.STUDENT, 'sender');
    const c = await named(Role.TEACHER, 'ustoz');
    const d = await named(Role.STUDENT, 'other');
    const open = (await api(t, a.token).post('/threads/direct', { userId: d.id })).body;
    assert.equal(open.status, 'REQUEST');
    assert.equal(open.requestedByMe, true);
    assert.equal((await api(t, a.token).post(`/threads/${open.id}/messages`, { body: 'Hello! Are you free to study together?' })).status, 201);
    const again = await api(t, a.token).post(`/threads/${open.id}/messages`, { body: 'Hello??' });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'REQUEST_PENDING');
    assert.equal((await api(t, a.token).post(`/threads/${open.id}/accept`)).status, 409, 'cannot accept your own request');
    const seen = (await api(t, d.token).get('/threads')).body.find((v: any) => v.id === open.id);
    assert.equal(seen.status, 'REQUEST');
    assert.equal(seen.requestedByMe, false);
    assert.equal((await api(t, d.token).post(`/threads/${open.id}/accept`)).body.status, 'ACTIVE');
    assert.equal((await api(t, a.token).post(`/threads/${open.id}/messages`, { body: 'Great!' })).status, 201);

    const open2 = (await api(t, a.token).post('/threads/direct', { userId: c.id })).body;
    await api(t, a.token).post(`/threads/${open2.id}/messages`, { body: 'Do you teach IELTS?' });
    assert.equal((await api(t, c.token).post(`/threads/${open2.id}/decline`)).status, 200);
    const blocked = await api(t, a.token).post(`/threads/${open2.id}/messages`, { body: 'Please?' });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'DECLINED');
    assert.equal((await api(t, c.token).get('/threads')).body.some((v: any) => v.id === open2.id), false, 'declined requests disappear for the receiver');
  });

  it('pupils under 18 can only message their own teacher; adults searching by @username never see minors', async () => {
    const kid = await named(Role.STUDENT, 'kid', { dateOfBirth: '2012-05-05', name: 'Kid Karimov' });
    const mate = await named(Role.STUDENT, 'mate');
    const stranger = await named(Role.STUDENT, 'stranger');
    const { x, c } = await classWith(mate);
    const g = await makeUser(t, Role.GUARDIAN);
    await t.prisma.guardianLink.create({ data: { guardianId: g.id, studentId: kid.id, status: 'ACTIVE' } });
    assert.equal((await api(t, g.token).post('/classes/join', { code: c.joinCode, studentId: kid.id })).status, 200);
    for (const target of [mate.id, stranger.id]) {
      const r = await api(t, kid.token).post('/threads/direct', { userId: target });
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'MINOR_RESTRICTED');
    }
    assert.equal((await api(t, mate.token).post('/threads/direct', { userId: kid.id })).status, 403, 'adults cannot start a chat with a minor classmate either');
    assert.equal((await api(t, kid.token).post('/threads/direct', { userId: x.user.id })).status, 200, 'own teacher is fine');
    assert.equal((await api(t, stranger.token).get(`/threads/people?q=${kid.username.slice(0, 5)}`)).body.length, 0);
    const found = (await api(t, stranger.token).get(`/threads/people?q=@${mate.username}`)).body;
    assert.equal(found[0].userId, mate.id);
    assert.deepEqual((await api(t, stranger.token).get('/threads/people?q=ab')).body, []);
    assert.equal(found.some((f: any) => f.userId === stranger.id), false, 'not yourself');
  });

  it('profile pictures: anyone can set one; classmates see adults; minors are visible only to their teacher and guardian', async () => {
    const adult = await named(Role.STUDENT, 'adult');
    const mate = await makeUser(t, Role.STUDENT);
    const kid = await named(Role.STUDENT, 'kidp', { dateOfBirth: '2012-05-05' });
    const outsider = await makeUser(t, Role.STUDENT);
    const { x, c } = await classWith(adult, mate);
    const g = await makeUser(t, Role.GUARDIAN);
    await t.prisma.guardianLink.create({ data: { guardianId: g.id, studentId: kid.id, status: 'ACTIVE' } });
    assert.equal((await api(t, g.token).post('/classes/join', { code: c.joinCode, studentId: kid.id })).status, 200);
    for (const u of [adult, kid]) {
      const up = await uploadFile(t, u, { mime: 'image/jpeg', bytes: await makeJpeg(), purpose: 'AVATAR', name: 'me.jpg' });
      assert.equal(up.complete.status, 200, JSON.stringify(up.complete.body));
      assert.equal((await api(t, u.token).put('/me/avatar', { fileId: up.fileId })).status, 200);
      assert.equal((await api(t, u.token).get('/me')).body.hasPhoto, true);
    }
    const get = (viewer: { token: string }, id: string) => fetch(`${t.baseUrl}/users/${id}/avatar`, { headers: { Authorization: `Bearer ${viewer.token}` } }).then((r) => r.status);
    assert.equal(await get(adult, adult.id), 200);
    assert.equal(await get(mate, adult.id), 200, 'classmate sees an adult');
    assert.equal(await get(outsider, adult.id), 404);
    assert.equal(await get(mate, kid.id), 404, 'classmates never see a minor');
    assert.equal(await get(x.user, kid.id), 200, 'the teacher does');
    assert.equal((await api(t, adult.token).del('/me/avatar')).status, 200);
    assert.equal(await get(mate, adult.id), 404);
  });

  it('class reviews: only after 2 finished lessons of the class, one per class; the stars cannot be hidden, only the text', async () => {
    const pupil = await named(Role.STUDENT, 'rater');
    const other = await makeUser(t, Role.STUDENT);
    const { x, c } = await classWith(pupil);
    const review = (u: { token: string }, rating: number, text = '') => api(t, u.token).post(`/classes/${c.id}/review`, { rating, text });
    const early = await review(pupil, 5, 'Great');
    assert.equal(early.status, 409);
    assert.equal(early.body.code, 'NOT_ENOUGH_LESSONS');
    assert.equal((await review(other, 5)).status, 404, 'not in the class');
    assert.ok([403, 404].includes((await api(t, x.user.token).post(`/classes/${c.id}/review`, { rating: 5 })).status), 'a teacher cannot rate their own class');
    for (let i = 0; i < 2; i++) {
      const s = await t.prisma.classSession.create({ data: { classId: c.id, startAt: new Date(Date.now() - (i + 2) * 86_400_000), endAt: new Date(Date.now() - (i + 2) * 86_400_000 + 3_600_000), status: 'ENDED', stageMode: 'HAND_RAISE', chatMode: 'OPEN', questionsMode: 'OPEN' } });
      await t.prisma.classAttendance.create({ data: { sessionId: s.id, pupilId: pupil.id, firstJoinedAt: s.startAt, totalSeconds: 3000 } });
    }
    assert.equal((await api(t, pupil.token).get(`/classes/${c.id}/review`)).body.canReview, true);
    const ok = await review(pupil, 4, 'Clear explanations, good pace');
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal((await review(pupil, 1)).status, 409, 'one per class');
    const prof = () => t.prisma.teacherProfile.findUniqueOrThrow({ where: { id: x.profileId } });
    assert.deepEqual([(await prof()).ratingCount, (await prof()).ratingSum], [1, 4]);

    // admin hides the text, never the stars
    assert.equal((await api(t, admin.token).post(`/admin/market/reviews/${ok.body.id}/hide`, { reason: 'abusive' })).status, 200);
    assert.deepEqual([(await prof()).ratingCount, (await prof()).ratingSum], [1, 4], 'rating unchanged');
    const list = (await api(t, other.token).get(`/teachers/${x.profileId}/reviews`)).body;
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].rating, 4);
    assert.equal(list.items[0].text, '');
    assert.equal(list.items[0].textHidden, true);
    assert.equal((await api(t, x.user.token).put(`/reviews/${ok.body.id}/reply`, { text: 'thanks' })).status, 409);
    assert.equal((await api(t, pupil.token).put(`/reviews/${ok.body.id}`, { rating: 5 })).status, 409, 'the author cannot work around the hiding');
    assert.equal((await api(t, x.user.token).post(`/admin/market/reviews/${ok.body.id}/hide`, {})).status, 401, 'teachers cannot hide anything');
  });

  it('comments can be reported; the admin queue hides the comment', async () => {
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const writer = await makeUser(t, Role.STUDENT, { name: 'Rude Person' });
    const reader = await makeUser(t, Role.STUDENT);
    const base = `/teachers/${x.profileId}/comments`;
    assert.equal((await api(t, writer.token).post(base, { text: 'Terrible teacher, total waste' })).status, 201);
    const cid = (await api(t, reader.token).get(base)).body.items[0].id;
    assert.equal((await api(t, writer.token).post(`${base}/${cid}/report`, { reason: 'ABUSE' })).status, 403, 'not your own');
    const rep = await api(t, reader.token).post(`${base}/${cid}/report`, { reason: 'ABUSE' });
    assert.equal(rep.status, 201, JSON.stringify(rep.body));
    assert.equal((await api(t, reader.token).post(`${base}/${cid}/report`, { reason: 'SPAM' })).status, 409);
    const q = (await api(t, admin.token).get('/admin/market/reports?targetType=COMMENT')).body;
    assert.equal(q.find((i: any) => i.id === rep.body.id).target.text.startsWith('Terrible'), true);
    assert.equal((await api(t, admin.token).post(`/admin/market/reports/${rep.body.id}/resolve`, { action: 'ACTION' })).body.status, 'ACTIONED');
    assert.equal((await api(t, reader.token).get(base)).body.items.length, 0);
  });

  it('profile card: classmates see name, @username and bio; strangers only name and @username; minors are hidden from classmates; the bio cannot hold a phone number or a link', async () => {
    const a = await named(Role.STUDENT, 'cardA', { name: 'Aziz Tursunov' });
    const mate = await makeUser(t, Role.STUDENT);
    const stranger = await named(Role.STUDENT, 'cardS');
    const kid = await named(Role.STUDENT, 'cardK', { dateOfBirth: '2012-05-05', name: 'Kid Karimov' });
    const { x, c } = await classWith(a, mate);
    const g = await makeUser(t, Role.GUARDIAN);
    await t.prisma.guardianLink.create({ data: { guardianId: g.id, studentId: kid.id, status: 'ACTIVE' } });
    assert.equal((await api(t, g.token).post('/classes/join', { code: c.joinCode, studentId: kid.id })).status, 200);
    assert.equal((await api(t, a.token).patch('/me', { bio: 'Preparing for IELTS. I like math and chess.' })).status, 200);
    assert.equal((await api(t, a.token).patch('/me', { bio: 'Call me +998 90 123 45 67' })).status, 400);
    assert.equal((await api(t, a.token).patch('/me', { bio: 'see t.me/someone' })).status, 400);
    const own = (await api(t, a.token).get('/me')).body;
    assert.equal(own.bio, 'Preparing for IELTS. I like math and chess.');
    const seen = (await api(t, mate.token).get(`/users/${a.id}/card`)).body;
    assert.deepEqual([seen.name, seen.username, seen.bio, seen.relation], ['Aziz Tursunov', a.username, own.bio, 'known']);
    const far = (await api(t, stranger.token).get(`/users/${a.id}/card`)).body;
    assert.deepEqual([far.username, far.bio, far.relation], [a.username, null, 'none']);
    assert.equal((await api(t, mate.token).get(`/users/${kid.id}/card`)).status, 404, 'a minor is not visible to a classmate');
    assert.equal((await api(t, x.user.token).get(`/users/${kid.id}/card`)).status, 200, 'the teacher sees their pupil');
  });
});
