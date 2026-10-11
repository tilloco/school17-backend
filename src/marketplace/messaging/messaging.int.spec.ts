import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { io, Socket } from 'socket.io-client';
import { ClockService } from '../common/clock';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makePdf, makeTeacher, makeThread, makeUser, TestApp, TestUser, uploadFile } from '../testing/harness';

const NOW = new Date('2026-11-02T00:00:00Z');

function connect(t: TestApp, token?: string): Promise<Socket> {
  return new Promise((resolve) => {
    const s = io(t.baseUrl, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false, forceNew: true });
    s.on('connect', () => resolve(s));
    s.on('disconnect', () => resolve(s));
    s.on('connect_error', () => resolve(s));
  });
}
const nextEvent = <T = any>(s: Socket, name: string, ms = 3000) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ' + name)), ms);
    s.once(name, (p: T) => {
      clearTimeout(timer);
      resolve(p);
    });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('messaging (integration)', () => {
  let t: TestApp;
  let clock: ClockService;
  let admin: { id: string; token: string };
  const sockets: Socket[] = [];

  async function setup(opts: { instant?: boolean } = {}) {
    const tch = await makeTeacher(t, { approve: { adminToken: admin.token } });
    await api(t, tch.user.token).put('/teachers/me/profile', { instantBooking: opts.instant ?? true });
    const student = await makeUser(t);
    const { threadId, bookingId } = await makeThread(t, tch, student);
    return { tch, student, threadId, bookingId };
  }

  before(async () => {
    t = await createTestApp();
    clock = t.app.get(ClockService);
    clock.set(NOW);
    admin = await makeAdmin(t);
  });
  after(async () => {
    sockets.forEach((s) => s.close());
    clock.set(null);
    await t.close();
  });

  it('route matrix', async () => {
    const actors = { STUDENT: await makeUser(t, Role.STUDENT), GUARDIAN: await makeUser(t, Role.GUARDIAN), TEACHER: await makeUser(t, Role.TEACHER), adminToken: admin.token };
    const id = '11111111-1111-4111-8111-111111111111';
    const failures = await checkRouteMatrix(t, actors, [
      { method: 'GET', path: '/threads', allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'GET', path: '/threads/unread-count', allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'POST', path: '/threads', body: { bookingId: id }, allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'GET', path: '/threads/' + id + '/messages', allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'POST', path: '/threads/' + id + '/messages', body: { body: 'hi' }, allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('one thread per teacher-pupil pair; needs a real booking; strangers get 404', async () => {
    const { tch, student, threadId, bookingId } = await setup();
    const again = await api(t, student.token).post('/threads', { bookingId });
    assert.equal(again.body.id, threadId, 'idempotent');
    const fromTeacher = await api(t, tch.user.token).post('/threads', { bookingId });
    assert.equal(fromTeacher.body.id, threadId, 'same thread from the other side');
    // ikkinchi bron ham o'sha suhbatni beradi
    const b2 = await api(t, student.token).post('/bookings', { teacherId: tch.profileId, startAt: '2026-11-04T05:00:00.000Z', durationMin: 60 });
    assert.equal((await api(t, student.token).post('/threads', { bookingId: b2.body.id })).body.id, threadId);
    assert.equal(await t.prisma.chatThread.count({ where: { teacherUserId: tch.user.id, studentUserId: student.id } }), 1);
    const stranger = await makeUser(t);
    assert.equal((await api(t, stranger.token).post('/threads', { bookingId })).status, 404);
    assert.equal(await t.prisma.chatThread.count({ where: { studentUserId: stranger.id } }), 0);
    // bekor qilingan bron suhbat ochmaydi
    const b3 = await api(t, student.token).post('/bookings', { teacherId: tch.profileId, startAt: '2026-11-05T05:00:00.000Z', durationMin: 60 });
    await api(t, student.token).post('/bookings/' + b3.body.id + '/cancel');
    const other = await makeTeacher(t, { approve: { adminToken: admin.token } });
    await api(t, other.user.token).put('/teachers/me/profile', { instantBooking: true });
    const b4 = await api(t, student.token).post('/bookings', { teacherId: other.profileId, startAt: '2026-11-05T05:00:00.000Z', durationMin: 60 });
    await api(t, student.token).post('/bookings/' + b4.body.id + '/cancel');
    assert.equal((await api(t, student.token).post('/threads', { bookingId: b4.body.id })).status, 409);
  });

  it('send, order, pagination, delivery states and unread counts', async () => {
    const { tch, student, threadId } = await setup();
    const s = api(t, student.token);
    const te = api(t, tch.user.token);
    assert.equal((await s.post('/threads/' + threadId + '/messages', { body: '  Salom!  ' })).body.body, 'Salom!');
    assert.equal((await s.post('/threads/' + threadId + '/messages', { body: 'Dars haqida savol' })).body.seq, 2);
    assert.equal((await te.get('/threads/unread-count')).body.unread, 2);
    assert.equal((await s.get('/threads/unread-count')).body.unread, 0, 'own messages are never unread');
    const list = (await te.get('/threads')).body;
    assert.equal(list[0].unread, 2);
    assert.equal(list[0].lastMessage.preview, 'Dars haqida savol');

    let mine = (await s.get('/threads/' + threadId + '/messages')).body;
    assert.deepEqual(mine.map((m: any) => [m.seq, m.state]), [[1, 'SENT'], [2, 'SENT']]);
    await te.post('/threads/' + threadId + '/delivered', { upToSeq: 2 });
    mine = (await s.get('/threads/' + threadId + '/messages')).body;
    assert.deepEqual(mine.map((m: any) => m.state), ['DELIVERED', 'DELIVERED']);
    await te.post('/threads/' + threadId + '/read', { upToSeq: 1 });
    mine = (await s.get('/threads/' + threadId + '/messages')).body;
    assert.deepEqual(mine.map((m: any) => m.state), ['READ', 'DELIVERED']);
    assert.equal((await te.get('/threads/unread-count')).body.unread, 1);
    // read never goes backwards, never beyond lastSeq
    await te.post('/threads/' + threadId + '/read', { upToSeq: 0 });
    await te.post('/threads/' + threadId + '/read', { upToSeq: 999 });
    assert.equal((await te.get('/threads/unread-count')).body.unread, 0);
    assert.equal((await t.prisma.chatThread.findUniqueOrThrow({ where: { id: threadId } })).teacherLastReadSeq, 2);

    for (let i = 3; i <= 7; i++) await te.post('/threads/' + threadId + '/messages', { body: 'm' + i });
    const page = (await s.get('/threads/' + threadId + '/messages?limit=3')).body;
    assert.deepEqual(page.map((m: any) => m.seq), [5, 6, 7]);
    const older = (await s.get('/threads/' + threadId + '/messages?limit=3&beforeSeq=5')).body;
    assert.deepEqual(older.map((m: any) => m.seq), [2, 3, 4]);
    const newer = (await s.get('/threads/' + threadId + '/messages?afterSeq=5')).body;
    assert.deepEqual(newer.map((m: any) => m.seq), [6, 7]);
    assert.equal(newer[0].mine, false);
  });

  it('validation: empty, too long, unknown fields; concurrent sends get unique ordered seq', async () => {
    const { student, tch, threadId } = await setup();
    const s = api(t, student.token);
    assert.equal((await s.post('/threads/' + threadId + '/messages', { body: '   ' })).status, 400);
    assert.equal((await s.post('/threads/' + threadId + '/messages', { body: 'x'.repeat(2001) })).status, 400);
    assert.equal((await s.post('/threads/' + threadId + '/messages', { body: 'hi', senderId: tch.user.id })).status, 400, 'cannot spoof sender');
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? s : api(t, tch.user.token)).post('/threads/' + threadId + '/messages', { body: 'p' + i })));
    assert.ok(results.every((r) => r.status === 201));
    const seqs = results.map((r) => r.body.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it('messages are plain text: HTML is stored and returned verbatim, never interpreted', async () => {
    const { student, threadId } = await setup();
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const r = await api(t, student.token).post('/threads/' + threadId + '/messages', { body: evil });
    assert.equal(r.body.body, evil); // clients must render as text (documented); server does not execute or rewrite
  });

  it('IDOR: outsiders cannot read, send, mark or list another pair\'s thread', async () => {
    const a = await setup();
    const b = await setup();
    await api(t, a.student.token).post('/threads/' + a.threadId + '/messages', { body: 'private' });
    const o = api(t, b.student.token);
    assert.equal((await o.get('/threads/' + a.threadId + '/messages')).status, 404);
    assert.equal((await o.post('/threads/' + a.threadId + '/messages', { body: 'x' })).status, 404);
    assert.equal((await o.post('/threads/' + a.threadId + '/read', { upToSeq: 1 })).status, 404);
    assert.equal((await api(t, b.tch.user.token).get('/threads/' + a.threadId + '/messages')).status, 404, 'other teacher');
    assert.ok(!(await o.get('/threads')).body.some((x: any) => x.id === a.threadId));
  });

  it('privacy: teacher sees only the pupil display name; minors abbreviated; no emails or ids', async () => {
    const tch = await makeTeacher(t, { approve: { adminToken: admin.token } });
    await api(t, tch.user.token).put('/teachers/me/profile', { instantBooking: true });
    const guardian = await makeUser(t, Role.GUARDIAN);
    const minor = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05', name: 'Aziz Karimov' });
    await t.prisma.guardianLink.create({ data: { guardianId: guardian.id, studentId: minor.id, status: 'ACTIVE' } });
    const b = (await api(t, guardian.token).post('/bookings', { teacherId: tch.profileId, startAt: '2026-11-03T05:00:00.000Z', durationMin: 60, studentId: minor.id })).body;
    const th = (await api(t, guardian.token).post('/threads', { bookingId: b.id })).body;
    await api(t, minor.token).post('/threads/' + th.id + '/messages', { body: 'Salom' });
    const list = (await api(t, tch.user.token).get('/threads')).body;
    assert.deepEqual(list[0].other, { name: 'Aziz K.' });
    const raw = JSON.stringify([list, (await api(t, tch.user.token).get('/threads/' + th.id + '/messages')).body]);
    for (const secret of [minor.email, guardian.email, minor.id, guardian.id]) assert.ok(!raw.includes(secret));
  });

  it('guardian of a minor: read-only access, live copy; cannot send or mark; unlinked guardian gets 404', async () => {
    const tch = await makeTeacher(t, { approve: { adminToken: admin.token } });
    await api(t, tch.user.token).put('/teachers/me/profile', { instantBooking: true });
    const guardian = await makeUser(t, Role.GUARDIAN);
    const stranger = await makeUser(t, Role.GUARDIAN);
    const minor = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05' });
    await t.prisma.guardianLink.create({ data: { guardianId: guardian.id, studentId: minor.id, status: 'ACTIVE' } });
    const b = (await api(t, guardian.token).post('/bookings', { teacherId: tch.profileId, startAt: '2026-11-03T05:00:00.000Z', durationMin: 60, studentId: minor.id })).body;
    const th = (await api(t, minor.token).post('/threads', { bookingId: b.id })).body;
    await api(t, tch.user.token).post('/threads/' + th.id + '/messages', { body: 'Salom' });
    const g = api(t, guardian.token);
    assert.equal((await g.get('/threads/' + th.id + '/messages')).body.length, 1);
    assert.equal((await g.post('/threads/' + th.id + '/messages', { body: 'x' })).status, 403);
    assert.equal((await g.post('/threads/' + th.id + '/read', { upToSeq: 1 })).status, 403);
    assert.equal((await g.get('/threads')).body[0].readOnly, true);
    assert.equal((await api(t, stranger.token).get('/threads/' + th.id + '/messages')).status, 404);
    await t.prisma.guardianLink.updateMany({ where: { guardianId: guardian.id }, data: { status: 'REVOKED' } });
    assert.equal((await g.get('/threads/' + th.id + '/messages')).status, 404, 'revoked link loses access');
  });

  it('attachments: sender must own a READY MESSAGE_ATTACHMENT file; recipient (and guardian) can download; outsiders cannot', async () => {
    const { tch, student, threadId } = await setup();
    const outsider = await makeUser(t);
    const mine = await uploadFile(t, student, { mime: 'application/pdf', bytes: makePdf(), name: 'homework.pdf' });
    const stolen = await uploadFile(t, outsider, { mime: 'application/pdf', bytes: makePdf() });
    const s = api(t, student.token);
    assert.equal((await s.post('/threads/' + threadId + '/messages', { fileId: stolen.fileId })).status, 404);
    const pending = await uploadFile(t, student, { mime: 'application/pdf', bytes: makePdf(), noComplete: true });
    assert.equal((await s.post('/threads/' + threadId + '/messages', { fileId: pending.fileId })).status, 409);
    const cred = await uploadFile(t, student, { mime: 'application/pdf', bytes: makePdf(), purpose: 'AVATAR' });
    assert.equal((await s.post('/threads/' + threadId + '/messages', { fileId: cred.fileId })).status, 400);

    const sent = await s.post('/threads/' + threadId + '/messages', { fileId: mine.fileId, body: 'Mana' });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.file.name, 'homework.pdf');
    assert.ok(!JSON.stringify(sent.body).includes('storageKey'));
    assert.equal((await s.post('/threads/' + threadId + '/messages', { fileId: mine.fileId })).status, 409, 'a file can be sent once');
    assert.equal((await s.del('/files/' + mine.fileId)).status, 409, 'sent file cannot be deleted');

    const url = (await api(t, tch.user.token).post('/files/' + mine.fileId + '/download-url', {})).body.url;
    assert.equal((await fetch(t.baseUrl + url)).status, 200);
    assert.equal((await api(t, outsider.token).post('/files/' + mine.fileId + '/download-url', {})).status, 404);
  });

  it('real time: recipient gets the message instantly; receipts flow back; outsiders and bad tokens get nothing', async () => {
    const { tch, student, threadId } = await setup();
    const outsider = await makeUser(t);
    const sTeacher = await connect(t, tch.user.token);
    const sStudent = await connect(t, student.token);
    const sOutsider = await connect(t, outsider.token);
    const sBad = await connect(t, 'not-a-token');
    const sNone = await connect(t);
    sockets.push(sTeacher, sStudent, sOutsider, sBad, sNone);
    assert.equal(sTeacher.connected, true);
    assert.equal(sBad.connected, false, 'invalid token must be disconnected');
    assert.equal(sNone.connected, false, 'missing token must be disconnected');

    const outsiderGot: unknown[] = [];
    sOutsider.on('message', (m) => outsiderGot.push(m));
    const gotT = nextEvent(sTeacher, 'message');
    const gotS = nextEvent(sStudent, 'message'); // yuboruvchining boshqa qurilmasi ham oladi
    await api(t, student.token).post('/threads/' + threadId + '/messages', { body: 'real-time salom' });
    const m = await gotT;
    assert.equal(m.body, 'real-time salom');
    assert.equal(m.mine, false);
    assert.equal((await gotS).mine, true);

    const receipt = nextEvent(sStudent, 'receipt');
    await api(t, tch.user.token).post('/threads/' + threadId + '/read', { upToSeq: 1 });
    assert.deepEqual(await receipt, { threadId, kind: 'read', upToSeq: 1 });
    await sleep(200);
    assert.deepEqual(outsiderGot, []);

    // client xonaga o'zi qo'shila olmaydi
    sOutsider.emit('join', { room: 'user:' + tch.user.id });
    const gotAgain = nextEvent(sTeacher, 'message');
    await api(t, student.token).post('/threads/' + threadId + '/messages', { body: 'ikkinchi' });
    await gotAgain;
    await sleep(200);
    assert.deepEqual(outsiderGot, []);
  });

  it('real time: a guardian receives a live read-only copy of the minor\'s messages', async () => {
    const tch = await makeTeacher(t, { approve: { adminToken: admin.token } });
    await api(t, tch.user.token).put('/teachers/me/profile', { instantBooking: true });
    const guardian = await makeUser(t, Role.GUARDIAN);
    const minor = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05' });
    await t.prisma.guardianLink.create({ data: { guardianId: guardian.id, studentId: minor.id, status: 'ACTIVE' } });
    const b = (await api(t, guardian.token).post('/bookings', { teacherId: tch.profileId, startAt: '2026-11-03T05:00:00.000Z', durationMin: 60, studentId: minor.id })).body;
    const th = (await api(t, guardian.token).post('/threads', { bookingId: b.id })).body;
    const sg = await connect(t, guardian.token);
    sockets.push(sg);
    const got = nextEvent(sg, 'message');
    await api(t, tch.user.token).post('/threads/' + th.id + '/messages', { body: 'Salom' });
    assert.equal((await got).body, 'Salom');
  });

  it('suspended recipient cannot receive new messages', async () => {
    const { student, threadId, tch } = await setup();
    await t.prisma.user.update({ where: { id: tch.user.id }, data: { status: 'SUSPENDED' } });
    assert.equal((await api(t, student.token).post('/threads/' + threadId + '/messages', { body: 'x' })).status, 409);
  });
});
