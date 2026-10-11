import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { CALL_PROVIDER } from '../calls/call-provider';
import { MockCallProvider } from '../calls/mock-provider';
import { ClockService } from '../common/clock';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makeTeacher, makeUser, TestApp, TestUser } from '../testing/harness';
import { ClassRoomService, classRoomName } from './class-room.service';

const START = '2026-11-05T10:00:00.000Z';
const at = (offsetMin: number) => new Date(new Date(START).getTime() + offsetMin * 60_000);
const decode = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

describe('class room core (R2, integration)', () => {
  let t: TestApp;
  let clock: ClockService;
  let mock: MockCallProvider;
  let room: ClassRoomService;
  let admin: { id: string; token: string };

  const teacher = () => makeTeacher(t, { approve: { adminToken: admin.token } });
  /** Sinf + seans + n ta o'quvchi (ismi "Pupil<i> Family") */
  async function setup(n = 3, extra: object = {}) {
    clock.set(new Date('2026-11-02T00:00:00Z'));
    const x = await teacher();
    const c = (await api(t, x.user.token).post('/classes', { title: 'Math', subject: 'Math', capacity: 30, oneOffStartAt: START, durationMin: 60, ...extra })).body;
    const pupils: TestUser[] = [];
    for (let i = 0; i < n; i++) {
      const u = await makeUser(t, Role.STUDENT, { name: `Pupil${i} Family${i}` });
      assert.equal((await api(t, u.token).post('/classes/join', { code: c.joinCode })).status, 200);
      pupils.push(u);
    }
    const sid = (await api(t, x.user.token).get(`/classes/${c.id}/sessions`)).body[0].id as string;
    return { x, c, sid, pupils, base: `/class-sessions/${sid}` };
  }
  async function live(n = 3, extra: object = {}) {
    const s = await setup(n, extra);
    clock.set(at(-5));
    assert.equal((await api(t, s.x.user.token).post(`${s.base}/start`)).status, 200);
    return s;
  }
  const ev = (type: 'participant_joined' | 'participant_left', sid: string, identity: string, when: Date) => ({ type, roomName: classRoomName(sid), identity, at: when });

  before(async () => {
    t = await createTestApp();
    clock = t.app.get(ClockService);
    mock = t.app.get(CALL_PROVIDER) as MockCallProvider;
    room = t.app.get(ClassRoomService);
    admin = await makeAdmin(t);
  });
  after(async () => {
    clock.set(null);
    await t.close();
  });

  it('route matrix', async () => {
    const actors = { STUDENT: await makeUser(t, Role.STUDENT), GUARDIAN: await makeUser(t, Role.GUARDIAN), TEACHER: (await teacher()).user, adminToken: admin.token };
    const id = '11111111-1111-4111-8111-111111111111';
    const p = `/class-sessions/${id}`;
    const failures = await checkRouteMatrix(t, actors, [
      { method: 'GET', path: p, allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'POST', path: `${p}/token`, allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'POST', path: `${p}/start`, allowed: ['TEACHER'] },
      { method: 'POST', path: `${p}/end`, allowed: ['TEACHER'] },
      { method: 'POST', path: `${p}/hand`, body: { raised: true }, allowed: ['STUDENT', 'GUARDIAN'] },
      { method: 'POST', path: `${p}/stage/take`, allowed: ['STUDENT', 'GUARDIAN'] },
      { method: 'POST', path: `${p}/stage/leave`, allowed: ['STUDENT', 'GUARDIAN'] },
      { method: 'POST', path: `${p}/stage/grant`, body: { pupilId: id, mode: 'VOICE' }, allowed: ['TEACHER'] },
      { method: 'POST', path: `${p}/stage/revoke`, body: { pupilId: id }, allowed: ['TEACHER'] },
      { method: 'POST', path: `${p}/stage/mode`, body: { mode: 'OPEN_STAGE' }, allowed: ['TEACHER'] },
      { method: 'POST', path: `${p}/mute-all`, allowed: ['TEACHER'] },
      { method: 'POST', path: `${p}/mute`, body: { pupilId: id }, allowed: ['TEACHER'] },
      { method: 'POST', path: `${p}/spotlight`, body: { pupilId: id }, allowed: ['TEACHER'] },
      { method: 'POST', path: `${p}/remove`, body: { pupilId: id }, allowed: ['TEACHER'] },
      { method: 'POST', path: `${p}/lock`, body: { locked: true }, allowed: ['TEACHER'] },
      { method: 'GET', path: `${p}/roster`, allowed: ['TEACHER'] },
      { method: 'GET', path: `${p}/attendance`, allowed: ['TEACHER'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('lifecycle: lobby opens 10 min before, teacher starts, tokens only while live, room closes on end', async () => {
    const { x, sid, pupils, base } = await setup(2);
    const p = pupils[0];
    clock.set(at(-60));
    assert.equal((await api(t, p.token).get(base)).body.status, 'SCHEDULED');
    assert.equal((await api(t, p.token).post(`${base}/token`)).status, 409, 'no token before live');
    clock.set(at(-11));
    assert.equal((await api(t, x.user.token).post(`${base}/start`)).body.code, 'TOO_EARLY');
    assert.equal((await api(t, p.token).post(`${base}/start`)).status, 403, 'a pupil cannot start');
    clock.set(at(-9));
    const lobby = (await api(t, p.token).get(base)).body;
    assert.equal(lobby.status, 'LOBBY');
    assert.equal(lobby.teacherReconnecting, false);
    assert.equal((await api(t, p.token).post(`${base}/token`)).body.code, 'NOT_LIVE', 'pupils wait in the lobby');
    const started = await api(t, x.user.token).post(`${base}/start`);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.status, 'LIVE');
    assert.ok(mock.classRooms.has(classRoomName(sid)));
    assert.equal((await api(t, x.user.token).post(`${base}/start`)).status, 200, 'start is idempotent');
    assert.equal((await t.prisma.notification.count({ where: { userId: p.id, type: 'class.live' } })), 1);
    assert.equal((await api(t, x.user.token).post(`${base}/end`)).body.status, 'ENDED');
    assert.ok(mock.closed.has(classRoomName(sid)));
    assert.equal((await api(t, p.token).post(`${base}/token`)).status, 409);
    assert.equal((await api(t, x.user.token).post(`${base}/start`)).body.code, 'SESSION_OVER');
  });

  it('tokens: pupils are viewers (no publish, no data, no metadata); first name only; teacher publishes; strangers get 404', async () => {
    const { x, pupils, base } = await live(2);
    const outsider = await makeUser(t);
    const other = await teacher();
    const pt = (await api(t, pupils[0].token).post(`${base}/token`)).body;
    const claims = decode(pt.token);
    assert.equal(claims.video.canPublish, false);
    assert.equal(claims.video.canPublishData, false);
    assert.equal(claims.video.canUpdateOwnMetadata, false);
    assert.equal(claims.video.canSubscribe, true);
    assert.equal(claims.name, 'Pupil0');
    assert.equal(claims.sub, pupils[0].id);
    const raw = JSON.stringify(claims);
    for (const secret of ['Family0', pupils[0].email, 'phone', 'card']) assert.ok(!raw.includes(secret), secret);
    assert.ok(claims.exp - claims.nbf <= 905, 'short-lived');
    assert.equal(pt.role, 'pupil');
    const tt = (await api(t, x.user.token).post(`${base}/token`)).body;
    assert.equal(decode(tt.token).video.canPublish, true);
    assert.equal(tt.role, 'teacher');
    assert.equal((await api(t, outsider.token).post(`${base}/token`)).status, 404);
    assert.equal((await api(t, other.user.token).post(`${base}/token`)).status, 404);
    assert.equal((await api(t, other.user.token).get(`${base}/roster`)).status, 404);
  });

  it('hand raise -> grant voice -> token reflects the grant -> revoke; permissions are set on the server', async () => {
    const { x, sid, pupils, base } = await live(3);
    const [a, b] = pupils;
    const room_ = classRoomName(sid);
    assert.equal((await api(t, a.token).post(`${base}/hand`, { raised: true })).body.handRaised, true);
    assert.equal(mock.attributes.get(`${room_}|${a.id}`)?.hand, '1', 'roster attribute is set');
    assert.equal((await api(t, b.token).post(`${base}/hand`, { raised: true })).status, 200);
    const roster = (await api(t, x.user.token).get(`${base}/roster`)).body;
    assert.deepEqual(roster.slice(0, 2).map((r: any) => r.pupilId), [a.id, b.id], 'raised hands first, oldest first');
    assert.equal(roster[2].hand, false);
    assert.equal((await api(t, a.token).post(`${base}/stage/grant`, { pupilId: a.id, mode: 'VOICE' })).status, 403, 'a pupil cannot grant');
    assert.equal((await api(t, a.token).post(`${base}/stage/take`)).body.code, 'NEEDS_APPROVAL');
    const g = await api(t, x.user.token).post(`${base}/stage/grant`, { pupilId: a.id, mode: 'VOICE' });
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.deepEqual(mock.permissions.get(`${room_}|${a.id}`), { canPublish: true, publishSources: ['microphone'] });
    assert.equal(g.body.stageCount, 1);
    assert.equal(decode((await api(t, a.token).post(`${base}/token`)).body.token).video.canPublish, true, 'a reconnect keeps the grant');
    assert.deepEqual(decode((await api(t, a.token).post(`${base}/token`)).body.token).video.canPublishSources, ['microphone']);
    assert.equal((await api(t, a.token).get(base)).body.me.handRaised, false, 'hand lowered by the grant');
    await api(t, x.user.token).post(`${base}/stage/grant`, { pupilId: a.id, mode: 'VOICE_VIDEO' });
    assert.deepEqual(mock.permissions.get(`${room_}|${a.id}`)?.publishSources, ['microphone', 'camera']);
    const rv = await api(t, x.user.token).post(`${base}/stage/revoke`, { pupilId: a.id });
    assert.equal(rv.body.stageCount, 0);
    assert.deepEqual(mock.permissions.get(`${room_}|${a.id}`), { canPublish: false, publishSources: [] });
    assert.ok(mock.muted.includes(`${room_}|${a.id}`));
    assert.equal(decode((await api(t, a.token).post(`${base}/token`)).body.token).video.canPublish, false);
    // chet o'quvchi/ro'yxatda bo'lmagan id
    assert.equal((await api(t, x.user.token).post(`${base}/stage/grant`, { pupilId: (await makeUser(t)).id, mode: 'VOICE' })).status, 404);
  });

  it('the stage holds at most 10 pupils even under parallel requests (the 11th is refused)', async () => {
    const { x, pupils, base } = await live(13);
    const res = await Promise.all(pupils.map((p) => api(t, x.user.token).post(`${base}/stage/grant`, { pupilId: p.id, mode: 'VOICE' })));
    assert.equal(res.filter((r) => r.status === 200).length, 10);
    assert.deepEqual([...new Set(res.filter((r) => r.status !== 200).map((r) => r.body.code))], ['STAGE_FULL']);
    assert.equal(await t.prisma.classParticipant.count({ where: { sessionId: base.split('/')[2], stage: { not: 'NONE' } } }), 10);
    // bo'shatilgan joyga yana bitta chiqa oladi; allaqachon sahnadagini qayta berish joy talab qilmaydi
    const onStage = res.map((r, i) => (r.status === 200 ? pupils[i] : null)).filter(Boolean) as TestUser[];
    const off = pupils.find((p) => !onStage.includes(p))!;
    assert.equal((await api(t, x.user.token).post(`${base}/stage/grant`, { pupilId: onStage[0].id, mode: 'VOICE_VIDEO' })).status, 200);
    await api(t, x.user.token).post(`${base}/stage/revoke`, { pupilId: onStage[1].id });
    assert.equal((await api(t, x.user.token).post(`${base}/stage/grant`, { pupilId: off.id, mode: 'VOICE' })).status, 200);
  });

  it('stage modes: LISTEN_ONLY blocks hands and clears the stage; OPEN_STAGE lets pupils take a slot (and respects the cap)', async () => {
    const { x, pupils, base } = await live(12);
    await api(t, x.user.token).post(`${base}/stage/grant`, { pupilId: pupils[0].id, mode: 'VOICE' });
    await api(t, pupils[1].token).post(`${base}/hand`, { raised: true });
    const lo = await api(t, x.user.token).post(`${base}/stage/mode`, { mode: 'LISTEN_ONLY' });
    assert.equal(lo.body.stageCount, 0);
    assert.equal((await api(t, pupils[1].token).get(base)).body.me.handRaised, false);
    assert.equal((await api(t, pupils[2].token).post(`${base}/hand`, { raised: true })).body.code, 'HAND_RAISE_OFF');
    assert.equal((await api(t, pupils[2].token).post(`${base}/stage/take`)).body.code, 'STAGE_CLOSED');
    await api(t, x.user.token).post(`${base}/stage/mode`, { mode: 'OPEN_STAGE' });
    const res = await Promise.all(pupils.map((p) => api(t, p.token).post(`${base}/stage/take`)));
    assert.equal(res.filter((r) => r.status === 200).length, 10, 'free slots only');
    assert.equal(res.filter((r) => r.status === 409 && r.body.code === 'STAGE_FULL').length, 2);
    const taker = pupils[res.findIndex((r) => r.status === 200)];
    assert.equal((await api(t, taker.token).post(`${base}/stage/leave`)).body.me.stage, 'NONE');
    assert.equal((await api(t, pupils[0].token).post(`${base}/stage/mode`, { mode: 'OPEN_STAGE' })).status, 403);
  });

  it('teacher controls: mute all, mute one, spotlight, remove (banned from re-entry), lock (no new tokens), end; all denied to pupils', async () => {
    const { x, sid, pupils, base } = await live(4);
    const [a, b, c, d] = pupils;
    const room_ = classRoomName(sid);
    for (const p of [a, b]) await api(t, x.user.token).post(`${base}/stage/grant`, { pupilId: p.id, mode: 'VOICE' });
    assert.equal((await api(t, x.user.token).post(`${base}/mute-all`)).body.muted, 2);
    assert.ok(mock.muted.includes(`${room_}|${a.id}`) && mock.muted.includes(`${room_}|${b.id}`));
    assert.equal((await api(t, x.user.token).post(`${base}/mute`, { pupilId: c.id })).status, 200);
    const sp = await api(t, x.user.token).post(`${base}/spotlight`, { pupilId: a.id });
    assert.equal(sp.body.spotlightPupilId, a.id);
    assert.equal(mock.attributes.get(`${room_}|${a.id}`)?.spotlight, '1');
    assert.equal((await api(t, x.user.token).post(`${base}/spotlight`, { pupilId: b.id })).body.spotlightPupilId, b.id);
    assert.equal(mock.attributes.get(`${room_}|${a.id}`)?.spotlight, '0');
    // o'quvchi hech narsani bajara olmaydi
    for (const path of ['mute-all', 'mute', 'spotlight', 'remove', 'lock', 'end']) assert.equal((await api(t, c.token).post(`${base}/${path}`, { pupilId: d.id, locked: true })).status, 403, path);
    assert.equal((await api(t, c.token).get(`${base}/roster`)).status, 403);
    // chiqarish
    assert.equal((await api(t, x.user.token).post(`${base}/remove`, { pupilId: d.id })).status, 200);
    assert.ok(mock.removed.includes(`${room_}|${d.id}`));
    assert.equal((await api(t, d.token).post(`${base}/token`)).body.code, 'REMOVED_FROM_SESSION');
    assert.equal((await api(t, d.token).post(`${base}/hand`, { raised: true })).status, 403);
    // qulf
    assert.equal((await api(t, x.user.token).post(`${base}/lock`, { locked: true })).body.locked, true);
    assert.equal((await api(t, c.token).post(`${base}/token`)).body.code, 'ROOM_LOCKED');
    assert.equal((await api(t, x.user.token).post(`${base}/token`)).status, 200, 'the teacher can still enter');
    await api(t, x.user.token).post(`${base}/lock`, { locked: false });
    assert.equal((await api(t, c.token).post(`${base}/token`)).status, 200);
    // yakun
    await api(t, x.user.token).post(`${base}/end`);
    assert.equal((await api(t, a.token).get(base)).body.me.stage, 'NONE', 'stage is cleared on end');
  });

  it('teacher drop: under 5 minutes keeps the room (pupils see "reconnecting"), longer ends the session as a teacher no-show', async () => {
    const { x, sid, base, pupils } = await live(2);
    clock.set(at(0));
    await room.handleEvents([ev('participant_joined', sid, x.user.id, at(0))]);
    clock.set(at(10));
    await room.handleEvents([ev('participant_left', sid, x.user.id, at(10))]);
    clock.set(at(12));
    assert.equal((await api(t, pupils[0].token).get(base)).body.teacherReconnecting, true);
    clock.set(at(14));
    assert.equal((await api(t, pupils[0].token).get(base)).body.status, 'LIVE', 'still open after 4 minutes');
    await room.handleEvents([ev('participant_joined', sid, x.user.id, at(14.5))]);
    assert.equal((await api(t, pupils[0].token).get(base)).body.teacherReconnecting, false, 'teacher is back');
    await room.handleEvents([ev('participant_left', sid, x.user.id, at(20))]);
    clock.set(at(25.5));
    assert.ok((await room.sweep()) >= 1);
    const s = (await api(t, pupils[0].token).get(base)).body;
    assert.equal(s.status, 'ENDED');
    assert.equal(s.teacherNoShow, true);
    assert.equal(s.endReason, 'teacher_dropped');
  });

  it('teacher no-show: a class nobody starts is closed after the configured wait and pupils are told', async () => {
    const { x, base, pupils } = await setup(2);
    clock.set(at(10));
    assert.equal((await api(t, pupils[0].token).get(base)).body.status, 'LOBBY');
    clock.set(at(16));
    assert.equal(await room.sweep() >= 1, true);
    const s = (await api(t, pupils[0].token).get(base)).body;
    assert.equal(s.status, 'ENDED');
    assert.equal(s.endReason, 'teacher_no_show');
    assert.equal(await t.prisma.notification.count({ where: { userId: pupils[1].id, type: 'class.teacher_noshow' } }), 1);
    assert.equal((await api(t, x.user.token).post(`${base}/start`)).body.code, 'SESSION_OVER');
  });

  it('attendance from webhooks: idempotent events, reconnects do not duplicate, late join, open presence closed on end', async () => {
    const { x, sid, base, pupils } = await live(3);
    const [a, b] = pupils;
    clock.set(at(0));
    const joinA = ev('participant_joined', sid, a.id, at(8)); // 8 min after the start: late
    await room.handleEvents([joinA, joinA]);
    await room.handleEvents([ev('participant_left', sid, a.id, at(18))]);
    await room.handleEvents([ev('participant_joined', sid, a.id, at(20))]); // reconnect
    await room.handleEvents([ev('participant_joined', sid, b.id, at(1))]);
    await room.handleEvents([ev('participant_left', sid, 'not-a-member', at(2)), ev('participant_joined', sid, (await makeUser(t)).id, at(2))]);
    assert.equal(await t.prisma.classAttendance.count({ where: { sessionId: sid } }), 2);
    clock.set(at(30));
    const before = (await api(t, x.user.token).get(`${base}/attendance`)).body;
    const ra = before.find((r: any) => r.pupilId === a.id);
    assert.equal(ra.joinCount, 2);
    assert.equal(ra.joinedLate, true);
    assert.equal(ra.totalSeconds, 10 * 60 + 10 * 60, '10 min + 10 min so far');
    assert.equal(before.find((r: any) => r.pupilId === b.id).joinedLate, false);
    assert.equal(before.find((r: any) => r.pupilId === pupils[2].id).attended, false);
    await api(t, x.user.token).post(`${base}/end`);
    const after_ = (await api(t, x.user.token).get(`${base}/attendance`)).body;
    assert.equal(after_.find((r: any) => r.pupilId === a.id).presentNow, false);
    assert.ok(after_.find((r: any) => r.pupilId === b.id).totalSeconds >= 29 * 60);
    assert.equal((await api(t, a.token).get(`${base}/attendance`)).status, 403);
  });

  it('abuse limit: raising hands is rate limited per user', async () => {
    const th = await createTestApp([], { throttle: true });
    try {
      const c2 = th.app.get(ClockService);
      c2.set(new Date('2026-11-02T00:00:00Z'));
      const tch = await makeTeacher(th, { approve: { adminToken: (await makeAdmin(th)).token } });
      const cl = (await api(th, tch.user.token).post('/classes', { title: 'Math', subject: 'Math', capacity: 5, oneOffStartAt: START })).body;
      const p = await makeUser(th);
      await api(th, p.token).post('/classes/join', { code: cl.joinCode });
      const sid = (await api(th, tch.user.token).get(`/classes/${cl.id}/sessions`)).body[0].id;
      c2.set(at(-5));
      await api(th, tch.user.token).post(`/class-sessions/${sid}/start`);
      const codes: number[] = [];
      for (let i = 0; i < 14; i++) codes.push((await api(th, p.token).post(`/class-sessions/${sid}/hand`, { raised: i % 2 === 0 })).status);
      assert.ok(codes.includes(429), 'hand raising is limited: ' + codes.join(','));
      assert.equal(codes.slice(0, 10).every((s) => s === 200), true);
      c2.set(null);
    } finally {
      await th.close();
    }
  });
});
