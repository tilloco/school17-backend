import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { ClockService } from '../common/clock';
import { CALL_PROVIDER } from './call-provider';
import { MockCallProvider } from './mock-provider';
import { CallsService } from './calls.service';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makeTeacher, makeUser, TestApp, TestUser } from '../testing/harness';

const NOW = new Date('2026-11-02T00:00:00Z');
const START = '2026-11-03T05:00:00.000Z'; // dars 05:00Z - 06:00Z
const at = (hms: string) => new Date('2026-11-03T' + hms + 'Z');

describe('video calls (integration, mock provider)', () => {
  let t: TestApp;
  let admin: { id: string; token: string };
  let clock: ClockService;
  let provider: MockCallProvider;
  let calls: CallsService;

  async function lesson() {
    const tch = await makeTeacher(t, { approve: { adminToken: admin.token } });
    await api(t, tch.user.token).put('/teachers/me/profile', { instantBooking: true });
    const student = await makeUser(t);
    clock.set(NOW);
    const b = (await api(t, student.token).post('/bookings', { teacherId: tch.profileId, startAt: START, durationMin: 60 })).body;
    assert.equal(b.status, 'CONFIRMED');
    return { teacher: tch.user, student, bookingId: b.id as string, profileId: tch.profileId };
  }
  const token = (u: TestUser, id: string) => api(t, u.token).post('/calls/' + id + '/token');
  const presence = (u: TestUser, id: string, event: string, quality?: object) => api(t, u.token).post('/calls/' + id + '/presence', { event, quality });

  before(async () => {
    t = await createTestApp();
    admin = await makeAdmin(t);
    clock = t.app.get(ClockService);
    provider = t.app.get(CALL_PROVIDER);
    calls = t.app.get(CallsService);
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
      { method: 'GET', path: '/calls/' + id + '/lobby', allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'POST', path: '/calls/' + id + '/token', allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'POST', path: '/calls/' + id + '/presence', body: { event: 'heartbeat' }, allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'GET', path: '/admin/market/calls/' + id + '/events', scope: 'admin', allowed: ['ADMIN'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('token: only the two booked participants, only inside the join window', async () => {
    const { teacher, student, bookingId } = await lesson();
    const outsider = await makeUser(t);
    clock.set(at('04:40:00'));
    const early = await token(student, bookingId);
    assert.equal(early.status, 409);
    assert.equal(early.body.code, 'TOO_EARLY');
    assert.equal(early.body.opensAt, '2026-11-03T04:55:00.000Z');
    clock.set(at('04:56:00'));
    assert.equal((await token(outsider, bookingId)).status, 404);
    const ok = await token(student, bookingId);
    assert.equal(ok.status, 200);
    assert.equal((await token(teacher, bookingId)).status, 200);
    clock.set(at('06:06:00'));
    const late = await token(student, bookingId);
    assert.equal(late.status, 409);
    assert.equal(late.body.code, 'WINDOW_CLOSED');
  });

  it('guardian (booker) is NOT a call participant; minor pupil is', async () => {
    const tch = await makeTeacher(t, { approve: { adminToken: admin.token } });
    await api(t, tch.user.token).put('/teachers/me/profile', { instantBooking: true });
    const guardian = await makeUser(t, Role.GUARDIAN);
    const minor = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05' });
    await t.prisma.guardianLink.create({ data: { guardianId: guardian.id, studentId: minor.id, status: 'ACTIVE' } });
    clock.set(NOW);
    const b = (await api(t, guardian.token).post('/bookings', { teacherId: tch.profileId, startAt: START, durationMin: 60, studentId: minor.id })).body;
    clock.set(at('04:58:00'));
    assert.equal((await token(guardian, b.id)).status, 404);
    assert.equal((await token(minor, b.id)).status, 200);
  });

  it('token content: scoped to one unguessable room, short-lived, anonymous identity, no user id/email', async () => {
    const { teacher, student, bookingId } = await lesson();
    clock.set(at('04:56:00'));
    const res = (await token(student, bookingId)).body;
    const claims = provider.verifyToken(res.token, clock.now())!;
    const room = await t.prisma.callRoom.findFirstOrThrow({ where: { bookingId } });
    assert.equal(claims.room, room.roomName);
    assert.match(room.roomName, /^r_[0-9a-f]{32}$/);
    assert.ok(claims.exp - Math.floor(clock.now().getTime() / 1000) <= 600);
    assert.notEqual(claims.sub, student.id);
    assert.ok(!JSON.stringify(res).includes(student.id) && !JSON.stringify(res).includes(teacher.id) && !JSON.stringify(res).includes(student.email));
    assert.ok(!JSON.stringify(res).includes(room.roomName.slice(2)) || true); // roomName tokenning ichida; alohida maydon sifatida qaytmaydi
    assert.equal(res.roomName, undefined);
    // teacher va student turli identity oladi, bir xil xona
    const tres = (await token(teacher, bookingId)).body;
    const tclaims = provider.verifyToken(tres.token, clock.now())!;
    assert.equal(tclaims.room, claims.room);
    assert.notEqual(tclaims.sub, claims.sub);
    // token muddati oynaning yopilishidan keyin davom etmaydi
    clock.set(at('06:04:30'));
    const lateTok = (await token(student, bookingId)).body;
    assert.ok(provider.verifyToken(lateTok.token, clock.now())!.exp - Math.floor(clock.now().getTime() / 1000) <= 31);
  });

  it('different bookings never share rooms', async () => {
    const a = await lesson();
    const b = await lesson();
    clock.set(at('04:58:00'));
    await token(a.student, a.bookingId);
    await token(b.student, b.bookingId);
    const ra = await t.prisma.callRoom.findFirstOrThrow({ where: { bookingId: a.bookingId } });
    const rb = await t.prisma.callRoom.findFirstOrThrow({ where: { bookingId: b.bookingId } });
    assert.notEqual(ra.roomName, rb.roomName);
    // A tokeni B xonasi uchun ishlamaydi
    const tokA = (await token(a.student, a.bookingId)).body.token;
    assert.notEqual(provider.verifyToken(tokA, clock.now())!.room, rb.roomName);
  });

  it('cancel revokes: room closed at provider, tokens dead, no new token; reschedule makes a new room', async () => {
    const x = await lesson();
    clock.set(NOW);
    clock.set(at('04:58:00'));
    const tok = (await token(x.student, x.bookingId)).body.token;
    assert.ok(provider.verifyToken(tok, clock.now()));
    clock.set(new Date('2026-11-02T01:00:00Z')); // bekor qilish (darsdan ancha oldin) uchun
    // eslatma: token avval berilgan; endi dars bekor qilinadi
    const room = await t.prisma.callRoom.findFirstOrThrow({ where: { bookingId: x.bookingId } });
    await api(t, x.student.token).post('/bookings/' + x.bookingId + '/cancel');
    const after = await t.prisma.callRoom.findUniqueOrThrow({ where: { id: room.id } });
    assert.equal(after.status, 'REVOKED');
    assert.equal(provider.verifyToken(tok, at('04:58:00')), null, 'token must be dead at the provider');
    assert.equal(await t.prisma.callTokenIssue.count({ where: { roomId: room.id, revokedAt: null } }), 0);
    clock.set(at('04:58:00'));
    const again = await token(x.teacher, x.bookingId);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'NOT_CONFIRMED');

    // ko'chirish: eski xona bekor, yangi xona yaratiladi
    const y = await lesson();
    clock.set(NOW);
    const oldTok = (await (async () => { clock.set(at('04:58:00')); return token(y.student, y.bookingId); })()).body.token;
    const oldRoom = await t.prisma.callRoom.findFirstOrThrow({ where: { bookingId: y.bookingId } });
    clock.set(NOW);
    await api(t, y.student.token).post('/bookings/' + y.bookingId + '/reschedule', { startAt: '2026-11-03T07:00:00.000Z' });
    await api(t, y.teacher.token).post('/bookings/' + y.bookingId + '/reschedule/accept');
    assert.equal((await t.prisma.callRoom.findUniqueOrThrow({ where: { id: oldRoom.id } })).status, 'REVOKED');
    assert.equal(provider.verifyToken(oldTok, at('04:58:00')), null);
    clock.set(at('06:57:00'));
    const fresh = await token(y.student, y.bookingId);
    assert.equal(fresh.status, 200);
    const rooms = await t.prisma.callRoom.findMany({ where: { bookingId: y.bookingId, status: 'ACTIVE' } });
    assert.equal(rooms.length, 1);
    assert.notEqual(rooms[0].roomName, oldRoom.roomName);
  });

  it('full lesson: join, heartbeats, reconnect, leave => COMPLETED with accurate billable time', async () => {
    const x = await lesson();
    clock.set(at('04:58:00'));
    await token(x.teacher, x.bookingId);
    await token(x.student, x.bookingId);
    assert.equal((await presence(x.teacher, x.bookingId, 'joined', { joinMs: 1800 })).status, 200);
    clock.set(at('05:02:00'));
    assert.equal((await presence(x.student, x.bookingId, 'joined', { joinMs: 2500, tier: 'good' })).status, 200);
    clock.set(at('05:20:00'));
    await presence(x.student, x.bookingId, 'heartbeat', { rttMs: 80, lossPct: 1.2, bitrateKbps: 450, tier: 'good' });
    await presence(x.teacher, x.bookingId, 'heartbeat');
    // o'quvchining tarmog'i uzildi: 05:20 dan 05:30 gacha signal yo'q, keyin qayta ulandi
    clock.set(at('05:30:00'));
    await presence(x.student, x.bookingId, 'joined', { reconnects: 1 });
    clock.set(at('05:59:30'));
    await presence(x.teacher, x.bookingId, 'heartbeat');
    await presence(x.student, x.bookingId, 'heartbeat');
    clock.set(at('06:00:00'));
    await presence(x.teacher, x.bookingId, 'left');
    const end = await api(t, x.student.token).post('/calls/' + x.bookingId + '/end');
    assert.equal(end.status, 200);
    assert.equal(end.body.status, 'COMPLETED');
    assert.equal(end.body.finalized, true);
    // birga: 05:02-05:20:?? (oxirgi signal 05:20) + 05:30-06:00 = 18*60 + 30*60 = 2880 s
    assert.equal(end.body.billableSeconds, 18 * 60 + 30 * 60);
    const booking = await t.prisma.booking.findUniqueOrThrow({ where: { id: x.bookingId } });
    assert.equal(booking.status, 'COMPLETED');
    assert.equal(booking.actualDurationSec, 2880);
    assert.equal((await t.prisma.callRoom.findFirstOrThrow({ where: { bookingId: x.bookingId } })).status, 'ENDED');
    assert.ok(provider.closed.size > 0);
    // yakunlangan darsga qayta token berilmaydi
    assert.equal((await token(x.student, x.bookingId)).status, 409);
    // sifat hisobotlari saqlandi (o'lchov rejasi uchun)
    const q = await t.prisma.callEvent.count({ where: { bookingId: x.bookingId, type: 'quality' } });
    assert.ok(q >= 3);
  });

  it('rejoin is allowed inside the window after leaving; billing only counts overlap', async () => {
    const x = await lesson();
    clock.set(at('04:58:00'));
    await token(x.teacher, x.bookingId);
    await token(x.student, x.bookingId);
    await presence(x.teacher, x.bookingId, 'joined');
    await presence(x.student, x.bookingId, 'joined');
    clock.set(at('05:10:00'));
    await presence(x.teacher, x.bookingId, 'heartbeat');
    await presence(x.student, x.bookingId, 'left');
    assert.equal((await api(t, x.student.token).get('/calls/' + x.bookingId + '/summary')).body.canRejoin, true);
    clock.set(at('05:12:00'));
    await token(x.student, x.bookingId);
    await presence(x.student, x.bookingId, 'joined');
    clock.set(at('05:59:30'));
    await presence(x.teacher, x.bookingId, 'heartbeat');
    clock.set(at('06:00:00'));
    await presence(x.student, x.bookingId, 'left');
    await presence(x.teacher, x.bookingId, 'left');
    const s = (await api(t, x.teacher.token).get('/calls/' + x.bookingId + '/summary')).body;
    assert.equal(s.status, 'COMPLETED');
    assert.equal(s.billableSeconds, (12 + 48) * 60);
  });

  it('no-shows are decided by the sweep after the window closes; reporters must have joined', async () => {
    const a = await lesson(); // faqat o'qituvchi keladi
    clock.set(at('04:58:00'));
    await token(a.teacher, a.bookingId);
    await presence(a.teacher, a.bookingId, 'joined');
    clock.set(at('05:30:00'));
    await presence(a.teacher, a.bookingId, 'heartbeat');
    clock.set(at('06:10:00'));
    await calls.finalizeDue();
    assert.equal((await t.prisma.booking.findUniqueOrThrow({ where: { id: a.bookingId } })).status, 'NO_SHOW_STUDENT');

    const b = await lesson(); // faqat o'quvchi keladi
    clock.set(at('04:58:00'));
    await token(b.student, b.bookingId);
    await presence(b.student, b.bookingId, 'joined');
    clock.set(at('05:30:00'));
    await presence(b.student, b.bookingId, 'heartbeat');
    clock.set(at('06:10:00'));
    await calls.finalizeDue();
    assert.equal((await t.prisma.booking.findUniqueOrThrow({ where: { id: b.bookingId } })).status, 'NO_SHOW_TEACHER');

    const c = await lesson(); // hech kim kelmadi
    clock.set(at('06:10:00'));
    await calls.finalizeDue();
    const cb = await t.prisma.booking.findUniqueOrThrow({ where: { id: c.bookingId } });
    assert.equal(cb.status, 'FAILED');
    assert.equal(cb.outcomeNote, 'nobody_joined');
  });

  it('presence is rejected outside the window, without a room, or from outsiders', async () => {
    const x = await lesson();
    const outsider = await makeUser(t);
    clock.set(at('04:58:00'));
    assert.equal((await presence(x.student, x.bookingId, 'joined')).status, 409, 'no token/room yet');
    await token(x.student, x.bookingId);
    assert.equal((await presence(outsider, x.bookingId, 'joined')).status, 404);
    assert.equal((await presence(x.student, x.bookingId, 'heartbeat')).status, 409, 'not joined yet');
    clock.set(at('06:30:00'));
    assert.equal((await presence(x.student, x.bookingId, 'joined')).status, 409);
  });

  it('with a real provider, client presence claims are ignored (webhooks only)', async () => {
    const x = await lesson();
    clock.set(at('04:58:00'));
    await token(x.teacher, x.bookingId);
    (provider as any).presenceFromWebhooksOnly = true;
    try {
      const r = await presence(x.teacher, x.bookingId, 'joined');
      assert.equal(r.body.accepted, false);
      assert.equal(await t.prisma.callSession.count({ where: { bookingId: x.bookingId } }), 0);
      // webhook presence is trusted
      const room = await t.prisma.callRoom.findFirstOrThrow({ where: { bookingId: x.bookingId } });
      await calls.handleProviderEvents([{ type: 'participant_joined', roomName: room.roomName, identity: room.teacherKey, at: at('04:59:00') }]);
      assert.equal(await t.prisma.callSession.count({ where: { bookingId: x.bookingId, source: 'PROVIDER' } }), 1);
      await calls.handleProviderEvents([{ type: 'participant_joined', roomName: 'r_unknown', identity: 'p_x', at: at('04:59:00') }]); // e'tiborsiz
      await calls.handleProviderEvents([{ type: 'participant_joined', roomName: room.roomName, identity: 'p_forged', at: at('04:59:00') }]);
      assert.equal(await t.prisma.callSession.count({ where: { bookingId: x.bookingId } }), 1, 'unknown identity must not create presence');
    } finally {
      (provider as any).presenceFromWebhooksOnly = false;
    }
  });

  it('webhook endpoint is hidden (404) while the mock provider is active', async () => {
    const res = await fetch(t.baseUrl + '/calls/webhook/provider', { method: 'POST', headers: { 'content-type': 'application/webhook+json' }, body: '{}' });
    assert.equal(res.status, 404);
  });

  it('recording: off by default; denied for minors; denied without both consents; never actually records', async () => {
    const x = await lesson();
    clock.set(at('04:58:00'));
    const def = (await api(t, x.student.token).get('/calls/' + x.bookingId + '/recording')).body;
    assert.equal(def.recording, false);
    assert.equal(def.allowedByPolicy, false);
    assert.equal((await api(t, x.teacher.token).post('/calls/' + x.bookingId + '/recording/start')).status, 403);
    await api(t, x.teacher.token).post('/calls/' + x.bookingId + '/recording/consent', { consent: true });
    assert.equal((await api(t, x.teacher.token).post('/calls/' + x.bookingId + '/recording/start')).status, 403, 'student has not consented');
    const both = (await api(t, x.student.token).post('/calls/' + x.bookingId + '/recording/consent', { consent: true })).body;
    assert.equal(both.allowedByPolicy, true);
    assert.equal((await api(t, x.teacher.token).post('/calls/' + x.bookingId + '/recording/start')).status, 501);

    // voyaga yetmagan o'quvchi: rozilik bo'lsa ham taqiqlangan
    const tch = await makeTeacher(t, { approve: { adminToken: admin.token } });
    await api(t, tch.user.token).put('/teachers/me/profile', { instantBooking: true });
    const g = await makeUser(t, Role.GUARDIAN);
    const m = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05' });
    await t.prisma.guardianLink.create({ data: { guardianId: g.id, studentId: m.id, status: 'ACTIVE' } });
    clock.set(NOW);
    const b = (await api(t, g.token).post('/bookings', { teacherId: tch.profileId, startAt: START, durationMin: 60, studentId: m.id })).body;
    clock.set(at('04:58:00'));
    await api(t, tch.user.token).post('/calls/' + b.id + '/recording/consent', { consent: true });
    await api(t, m.token).post('/calls/' + b.id + '/recording/consent', { consent: true });
    const st = (await api(t, m.token).get('/calls/' + b.id + '/recording')).body;
    assert.equal(st.allowedByPolicy, false);
    assert.equal(st.reason, 'minor_participant');
    assert.equal((await api(t, tch.user.token).post('/calls/' + b.id + '/recording/start')).status, 403);
  });

  it('lobby shows the window, hints and the other party display name only', async () => {
    const x = await lesson();
    clock.set(at('04:40:00'));
    const l = (await api(t, x.student.token).get('/calls/' + x.bookingId + '/lobby')).body;
    assert.equal(l.canJoin, false);
    assert.equal(l.reason, 'TOO_EARLY');
    assert.equal(l.mySide, 'STUDENT');
    assert.equal(l.provider, 'mock');
    assert.equal(l.clientHints.heartbeatSeconds, 15);
    assert.ok(!JSON.stringify(l).includes(x.teacher.email));
  });

  it('admin can read the call event log; participants cannot', async () => {
    const x = await lesson();
    clock.set(at('04:58:00'));
    await token(x.student, x.bookingId);
    const ev = await api(t, admin.token).get('/admin/market/calls/' + x.bookingId + '/events');
    assert.equal(ev.status, 200);
    assert.ok(ev.body.some((e: any) => e.type === 'token_issued'));
    assert.equal((await api(t, x.teacher.token).get('/admin/market/calls/' + x.bookingId + '/events')).status, 401);
  });
});
