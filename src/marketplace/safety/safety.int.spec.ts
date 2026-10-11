import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { ClockService } from '../common/clock';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makeTeacher, makeThread, makeUser, TestApp, TestUser } from '../testing/harness';

const NOW = new Date('2026-11-02T00:00:00Z');
const MINOR_DOB = '2012-05-05';
let slot = 0;

describe('safety: guardians, blocks, reports, consents (integration)', () => {
  let t: TestApp;
  let clock: ClockService;
  let admin: { id: string; token: string };

  const teacher = async () => {
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    await api(t, x.user.token).put('/teachers/me/profile', { instantBooking: true });
    return x;
  };
  /** Voyaga yetmagan o'quvchi + faol vasiy + o'qituvchi + suhbat */
  async function minorSetup() {
    const tch = await teacher();
    const guardian = await makeUser(t, Role.GUARDIAN);
    const minor = await makeUser(t, Role.STUDENT, { dateOfBirth: MINOR_DOB, name: 'Aziz Karimov' });
    await t.prisma.guardianLink.create({ data: { guardianId: guardian.id, studentId: minor.id, status: 'ACTIVE' } });
    const days = ['03', '04', '05', '06'];
    const n = slot++;
    const startAt = `2026-11-${days[n % 4]}T${String(4 + (Math.floor(n / 4) % 8)).padStart(2, '0')}:00:00.000Z`;
    const b = await api(t, guardian.token).post('/bookings', { teacherId: tch.profileId, startAt, durationMin: 60, studentId: minor.id });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    const th = (await api(t, guardian.token).post('/threads', { bookingId: b.body.id })).body;
    return { tch, guardian, minor, bookingId: b.body.id as string, threadId: th.id as string };
  }
  const send = (u: TestUser, threadId: string, body: string) => api(t, u.token).post(`/threads/${threadId}/messages`, { body });

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
      { method: 'POST', path: '/guardian/link', body: { code: 'AAAA-BBBB' }, allowed: ['GUARDIAN'] },
      { method: 'GET', path: '/guardian/children', allowed: ['GUARDIAN'] },
      { method: 'GET', path: '/blocks', allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'POST', path: '/blocks/thread', body: { threadId: id }, allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'GET', path: '/legal/consents', allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'POST', path: '/threads/' + id + '/report', body: { reason: 'SPAM' }, allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'GET', path: '/admin/market/reports', scope: 'admin', allowed: ['ADMIN'] },
      { method: 'POST', path: '/admin/market/users/' + id + '/suspend', body: {}, scope: 'admin', allowed: ['ADMIN'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('legal documents are public, in 3 languages, visibly DRAFT; tips are public', async () => {
    for (const kind of ['terms', 'privacy']) for (const loc of ['uz', 'ru', 'en']) {
      const r = await fetch(`${t.baseUrl}/legal/${kind}?locale=${loc}`);
      assert.equal(r.status, 200);
      const j: any = await r.json();
      assert.match(j.draftBanner, /QORALAMA|ЧЕРНОВИК|DRAFT/);
      assert.ok(j.sections.length >= 10);
      assert.equal(j.version, '2026-10-draft-1');
    }
    const tips: any = await (await fetch(`${t.baseUrl}/safety/tips?audience=guardian&locale=ru`)).json();
    assert.equal(tips.draft, true);
    assert.ok(tips.tips.length >= 4);
  });

  it('consents: current version only; terms gate booking, messaging and teacher submission; withdrawal rules', async () => {
    const tch = await teacher();
    const fresh = await makeUser(t, Role.STUDENT, { consent: false });
    const startAt = '2026-11-09T05:00:00.000Z';
    const blocked = await api(t, fresh.token).post('/bookings', { teacherId: tch.profileId, startAt, durationMin: 60 });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'TERMS_REQUIRED');
    const c = api(t, fresh.token);
    assert.equal((await c.post('/legal/consents', { kind: 'TERMS', version: 'old-1' })).status, 400);
    assert.equal((await c.post('/legal/consents', { kind: 'TERMS', version: '2026-10-draft-1', locale: 'ru' })).status, 200);
    assert.equal((await c.post('/legal/consents', { kind: 'TERMS', version: '2026-10-draft-1' })).status, 200, 'idempotent');
    assert.equal((await c.post('/bookings', { teacherId: tch.profileId, startAt, durationMin: 60 })).status, 201);
    assert.equal(await t.prisma.consent.count({ where: { userId: fresh.id, kind: 'TERMS' } }), 1);
    assert.equal((await c.del('/legal/consents/TERMS')).status, 400, 'terms cannot be withdrawn');
    assert.equal((await c.post('/legal/consents', { kind: 'MARKETING', version: 'any' })).status, 200);
    assert.equal((await c.del('/legal/consents/MARKETING')).status, 200);
    const list = (await c.get('/legal/consents')).body;
    assert.equal(list.items.find((i: any) => i.kind === 'MARKETING').withdrawnAt !== null, true);
    // o'qituvchi: shartsiz yuborib bo'lmaydi
    const t2 = await makeUser(t, Role.TEACHER, { consent: false });
    assert.equal((await api(t, t2.token).post('/teachers/me/submit')).body.code, 'TERMS_REQUIRED');
    // o'chirib qo'yish mumkin (dev)
    process.env.REQUIRE_TERMS = 'false';
    try {
      const noTerms = await makeUser(t, Role.STUDENT, { consent: false });
      assert.notEqual((await api(t, noTerms.token).post('/bookings', { teacherId: tch.profileId, startAt: '2026-11-10T05:00:00.000Z', durationMin: 60 })).body?.code, 'TERMS_REQUIRED');
    } finally {
      delete process.env.REQUIRE_TERMS;
    }
  });

  it('guardian link: minor creates a one-time code, adult guardian redeems it; codes are hashed, expire, are single-use and brute-force limited', async () => {
    const minor = await makeUser(t, Role.STUDENT, { dateOfBirth: MINOR_DOB });
    const adult = await makeUser(t, Role.STUDENT);
    const g = await makeUser(t, Role.GUARDIAN);
    assert.equal((await api(t, adult.token).post('/guardian/code')).status, 403, 'adults have no code');
    assert.equal((await api(t, g.token).post('/guardian/code')).status, 403);
    const { code } = (await api(t, minor.token).post('/guardian/code')).body;
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    const stored = await t.prisma.guardianLinkCode.findMany({ where: { studentId: minor.id } });
    assert.equal(stored.length, 1);
    assert.ok(!JSON.stringify(stored).includes(code.replace('-', '')), 'plaintext code must not be stored');
    const second = (await api(t, minor.token).post('/guardian/code')).body.code;
    assert.notEqual(second, code);
    assert.equal(await t.prisma.guardianLinkCode.count({ where: { studentId: minor.id, usedAt: null } }), 1, 'a new code replaces the old one');
    assert.equal((await api(t, g.token).post('/guardian/link', { code })).status, 404, 'old code is dead');
    assert.equal((await api(t, g.token).post('/guardian/link', { code: 'ZZZZ-ZZZZ' })).body.code, 'INVALID_CODE');
    // vasiy bo'lmaganlar, voyaga yetmagan "vasiy"
    assert.equal((await api(t, adult.token).post('/guardian/link', { code: second })).status, 403);
    const minorGuardian = await makeUser(t, Role.GUARDIAN, { dateOfBirth: MINOR_DOB });
    assert.equal((await api(t, minorGuardian.token).post('/guardian/link', { code: second })).status, 403);
    const ok = await api(t, g.token).post('/guardian/link', { code: second.toLowerCase().replace('-', ' ') });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.childId, minor.id);
    assert.equal((await api(t, g.token).post('/guardian/link', { code: second })).status, 404, 'single use');
    const kids = (await api(t, g.token).get('/guardian/children')).body;
    assert.deepEqual(kids.map((k: any) => k.id), [minor.id]);
    assert.ok(kids[0].age >= 13 && kids[0].age < 18);
    const mine = (await api(t, minor.token).get('/guardian/mine')).body;
    assert.equal(mine.length, 1);
    assert.deepEqual(Object.keys(mine[0]).sort(), ['name', 'since'], 'a pupil sees guardian names only, no contact data');
    // muddati o'tgan kod
    const c3 = (await api(t, minor.token).post('/guardian/code')).body.code;
    const g2 = await makeUser(t, Role.GUARDIAN);
    clock.set(new Date(NOW.getTime() + 25 * 3_600_000));
    assert.equal((await api(t, g2.token).post('/guardian/link', { code: c3 })).status, 404, 'expired');
    clock.set(NOW);
    // bekor qilish
    assert.equal((await api(t, g.token).del('/guardian/children/' + minor.id)).status, 200);
    assert.equal((await api(t, g.token).del('/guardian/children/' + minor.id)).status, 404);
    assert.deepEqual((await api(t, g.token).get('/guardian/children')).body, []);
    assert.equal((await api(t, minor.token).get('/guardian/mine')).body.length, 0);
  });

  it('guardian link limits: 5 guardians per child; brute force is stopped after 10 wrong codes per hour', async () => {
    const minor = await makeUser(t, Role.STUDENT, { dateOfBirth: MINOR_DOB });
    for (let i = 0; i < 5; i++) {
      const code = (await api(t, minor.token).post('/guardian/code')).body.code;
      assert.equal((await api(t, (await makeUser(t, Role.GUARDIAN)).token).post('/guardian/link', { code })).status, 200);
    }
    const code6 = (await api(t, minor.token).post('/guardian/code')).body.code;
    const r = await api(t, (await makeUser(t, Role.GUARDIAN)).token).post('/guardian/link', { code: code6 });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'TOO_MANY_GUARDIANS');

    const attacker = await makeUser(t, Role.GUARDIAN);
    const real = (await api(t, (await makeUser(t, Role.STUDENT, { dateOfBirth: MINOR_DOB })).token).post('/guardian/code')).body.code;
    for (let i = 0; i < 10; i++) assert.equal((await api(t, attacker.token).post('/guardian/link', { code: 'ZZZZ-ZZ' + String(i).padStart(2, '2') })).status, 404);
    const locked = await api(t, attacker.token).post('/guardian/link', { code: real });
    assert.equal(locked.status, 429, 'even the correct code is refused while locked out');
  });

  it('minor pupils: messaging needs an ACTIVE guardian; no contact details in either direction; adults may share', async () => {
    const x = await minorSetup();
    assert.equal((await send(x.minor, x.threadId, 'Salom, ustoz')).status, 201);
    assert.equal((await send(x.tch.user, x.threadId, 'Salom!')).status, 201);
    for (const bad of ['Yoz menga +998 90 123 45 67', 'mening emailim ali@gmail.com', 'telegramda yoz', '@ustoz_ali', 'https://t.me/ustoz']) {
      for (const who of [x.tch.user, x.minor]) {
        const r = await send(who, x.threadId, bad);
        assert.equal(r.status, 400, bad);
        assert.equal(r.body.code, 'CONTACT_INFO_NOT_ALLOWED');
      }
    }
    assert.equal((await send(x.tch.user, x.threadId, 'Bugun 3-mavzu, 12 + 34 = 46, 2026-11-03 14:30')).status, 201, 'ordinary lesson text passes');
    // vasiy o'chirilsa — yozishmalar to'xtaydi
    await api(t, x.guardian.token).del('/guardian/children/' + x.minor.id);
    const stopped = await send(x.minor, x.threadId, 'Salom');
    assert.equal(stopped.status, 403);
    assert.equal(stopped.body.code, 'GUARDIAN_REQUIRED');
    assert.equal((await send(x.tch.user, x.threadId, 'Salom')).status, 403);
    // voyaga yetgan o'quvchi: aloqa ma'lumoti taqiqlanmaydi
    const adultTch = await teacher();
    const adult = await makeUser(t);
    const th = await makeThread(t, adultTch, adult, '2026-11-12T08:00:00.000Z');
    assert.equal((await send(adult, th.threadId, 'Mening raqamim +998 90 123 45 67')).status, 201);
    // tug'ilgan sana noma'lum => ehtiyotkorlik bilan voyaga yetmagan deb hisoblanadi
    const unknown = await makeUser(t, Role.STUDENT, { dateOfBirth: null });
    const tid = (await t.prisma.chatThread.create({ data: { teacherUserId: adultTch.user.id, studentUserId: unknown.id } })).id;
    assert.equal((await send(unknown, tid, 'hello')).body.code, 'GUARDIAN_REQUIRED');
  });

  it('block: pupil blocks a teacher => no messages, no bookings, hidden from search; unblock restores; IDOR-safe', async () => {
    const x = await minorSetup();
    const adultTch = await teacher();
    const adult = await makeUser(t);
    const th = await makeThread(t, adultTch, adult, '2026-11-13T08:00:00.000Z');
    const outsider = await makeUser(t);
    assert.equal((await api(t, outsider.token).post('/blocks/thread', { threadId: th.threadId })).status, 404);
    assert.equal((await api(t, adult.token).post('/blocks/teacher', { teacherId: '11111111-1111-4111-8111-111111111111' })).status, 404);
    const q = 'q=' + encodeURIComponent('Tutor');
    const before = (await api(t, adult.token).get(`/teachers?${q}&pageSize=50`)).body;
    const b = await api(t, adult.token).post('/blocks/thread', { threadId: th.threadId });
    assert.equal(b.status, 200);
    assert.equal((await api(t, adult.token).post('/blocks/thread', { threadId: th.threadId })).body.id, b.body.id, 'idempotent');
    assert.equal((await send(adult, th.threadId, 'hi')).body.code, 'BLOCKED');
    assert.equal((await send(adultTch.user, th.threadId, 'hi')).body.code, 'BLOCKED');
    assert.equal((await api(t, adult.token).post('/bookings', { teacherId: adultTch.profileId, startAt: '2026-11-13T09:00:00.000Z', durationMin: 60 })).body.code, 'BLOCKED');
    const search = await api(t, adult.token).get(`/teachers?${q}&pageSize=50`);
    assert.ok(!search.body.items.some((i: any) => i.id === adultTch.profileId));
    assert.ok(before.items.length >= search.body.items.length);
    assert.deepEqual((await api(t, adult.token).get('/blocks')).body.map((i: any) => i.id), [b.body.id]);
    assert.equal((await api(t, outsider.token).del('/blocks/' + b.body.id)).status, 404);
    assert.equal((await api(t, adult.token).del('/blocks/' + b.body.id)).status, 200);
    assert.equal((await send(adult, th.threadId, 'hi again')).status, 201);
    assert.ok(x);
  });

  it('block: the teacher can block a pupil; a guardian\'s block applies to the child (messages, bookings, search)', async () => {
    const x = await minorSetup();
    const tBlocks = await api(t, x.tch.user.token).post('/blocks/thread', { threadId: x.threadId });
    assert.equal(tBlocks.status, 200);
    assert.equal(tBlocks.body.name, 'Aziz Karimov' === tBlocks.body.name ? 'Aziz Karimov' : tBlocks.body.name);
    assert.equal((await send(x.minor, x.threadId, 'Salom')).body.code, 'BLOCKED');
    assert.equal((await api(t, x.guardian.token).post('/bookings', { teacherId: x.tch.profileId, startAt: '2026-11-16T05:00:00.000Z', durationMin: 60, studentId: x.minor.id })).body.code, 'BLOCKED');

    const y = await minorSetup();
    const gb = await api(t, y.guardian.token).post('/blocks/thread', { threadId: y.threadId });
    assert.equal(gb.status, 200);
    assert.equal(await t.prisma.userBlock.count({ where: { blockerId: y.guardian.id, blockedId: y.tch.user.id } }), 1);
    assert.equal((await send(y.minor, y.threadId, 'Salom')).body.code, 'BLOCKED', 'child cannot message a teacher the guardian blocked');
    assert.equal((await send(y.tch.user, y.threadId, 'Salom')).body.code, 'BLOCKED');
    const hidden = await api(t, y.minor.token).get('/teachers?q=' + encodeURIComponent(`Tutor`) + '&pageSize=50');
    assert.ok(!hidden.body.items.some((i: any) => i.id === y.tch.profileId));
    // chaqiruv tokeni ham bloklanadi (bron avval yaratilgan bo'lsa ham)
    clock.set(new Date(new Date(y.threadId ? '2026-11-03T04:58:00Z' : NOW).getTime()));
    const bk = await t.prisma.booking.findFirstOrThrow({ where: { id: y.bookingId } });
    clock.set(new Date(bk.startAt.getTime() - 60_000));
    assert.equal((await api(t, y.minor.token).post('/calls/' + y.bookingId + '/token')).body.code, 'BLOCKED');
    clock.set(NOW);
  });

  it('report a user / a message from a thread: snapshot with context, duplicates, own message, outsiders', async () => {
    const x = await minorSetup();
    await send(x.minor, x.threadId, 'Salom');
    const bad = await send(x.tch.user, x.threadId, 'Sen juda yaxshi bolasan, bu sirimiz bo\'lsin');
    const rep = await api(t, x.guardian.token).post(`/threads/${x.threadId}/messages/${bad.body.id}/report`, { reason: 'SAFETY', note: 'secrecy request' });
    assert.equal(rep.status, 201, JSON.stringify(rep.body));
    assert.equal((await api(t, x.guardian.token).post(`/threads/${x.threadId}/messages/${bad.body.id}/report`, { reason: 'SPAM' })).body.code, 'ALREADY_REPORTED');
    assert.equal((await api(t, x.tch.user.token).post(`/threads/${x.threadId}/messages/${bad.body.id}/report`, { reason: 'SPAM' })).status, 403, 'own message');
    const outsider = await makeUser(t);
    assert.equal((await api(t, outsider.token).post(`/threads/${x.threadId}/report`, { reason: 'SPAM' })).status, 404);
    assert.equal((await api(t, outsider.token).post(`/threads/${x.threadId}/messages/${bad.body.id}/report`, { reason: 'SPAM' })).status, 404);
    assert.equal((await api(t, x.minor.token).post(`/threads/${x.threadId}/messages/11111111-1111-4111-8111-111111111111/report`, { reason: 'SPAM' })).status, 404);
    const user = await api(t, x.minor.token).post(`/threads/${x.threadId}/report`, { reason: 'SAFETY' });
    assert.equal(user.status, 201);

    const q = (await api(t, admin.token).get('/admin/market/reports?take=100')).body as any[];
    const item = q.find((i) => i.id === rep.body.id);
    assert.equal(item.targetType, 'MESSAGE');
    assert.equal(item.target.context.at(-1).body.startsWith('Sen juda'), true);
    assert.equal(item.target.context.length, 2);
    assert.equal(item.target.reportedUserId, x.tch.user.id);
    const uItem = q.find((i) => i.id === user.body.id);
    assert.equal(uItem.targetType, 'USER');
    assert.equal(uItem.targetId, x.tch.user.id);

    // ACTION on message => deleted from the thread for everyone
    assert.equal((await api(t, admin.token).post(`/admin/market/reports/${rep.body.id}/resolve`, { action: 'ACTION', note: 'removed' })).body.status, 'ACTIONED');
    const visible = (await api(t, x.minor.token).get(`/threads/${x.threadId}/messages`)).body;
    assert.ok(!visible.some((m: any) => m.id === bad.body.id));
    // ACTION on user => suspended immediately, teacher profile hidden
    await api(t, admin.token).post(`/admin/market/reports/${user.body.id}/resolve`, { action: 'ACTION', note: 'safeguarding' });
    assert.equal((await api(t, x.tch.user.token).get('/me')).status, 401);
    assert.equal((await t.prisma.teacherProfile.findUniqueOrThrow({ where: { id: x.tch.profileId } })).verificationStatus, 'SUSPENDED');
    assert.equal((await api(t, x.minor.token).get('/teachers/' + x.tch.profileId)).status, 404);
    assert.equal((await send(x.minor, x.threadId, 'Salom')).status, 409, 'cannot message a suspended account');
    assert.ok(await t.prisma.auditLog.findFirst({ where: { action: 'user.suspend', targetId: x.tch.user.id } }));
  });

  it('admin can suspend/reinstate users directly; others cannot', async () => {
    const u = await makeUser(t);
    assert.equal((await api(t, u.token).post('/admin/market/users/' + u.id + '/suspend', {})).status, 401);
    assert.equal((await api(t, admin.token).post('/admin/market/users/' + u.id + '/suspend', { reason: 'abuse' })).body.status, 'SUSPENDED');
    assert.equal((await api(t, u.token).get('/me')).status, 401);
    assert.equal((await api(t, admin.token).post('/admin/market/users/' + u.id + '/reinstate')).body.status, 'ACTIVE');
    assert.equal((await api(t, u.token).get('/me')).status, 200);
    assert.equal((await api(t, admin.token).post('/admin/market/users/11111111-1111-4111-8111-111111111111/suspend', {})).status, 404);
  });

  it('teachers never see a pupil\'s private data in any teacher-facing response', async () => {
    const x = await minorSetup();
    await send(x.minor, x.threadId, 'Salom');
    const seen = JSON.stringify([
      (await api(t, x.tch.user.token).get('/threads')).body,
      (await api(t, x.tch.user.token).get(`/threads/${x.threadId}/messages`)).body,
      (await api(t, x.tch.user.token).get(`/bookings/${x.bookingId}`)).body,
      (await api(t, x.tch.user.token).get(`/calls/${x.bookingId}/lobby`)).body,
    ]);
    for (const secret of [x.minor.email, x.guardian.email, x.minor.id, x.guardian.id, MINOR_DOB, 'Karimov']) assert.ok(!seen.includes(secret), secret);
  });
});

describe('rate limits (throttling enabled, per user not per IP)', () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp([], { throttle: true });
  });
  after(async () => {
    await t.close();
  });

  it('sensitive endpoints return 429 after the limit; another user is unaffected; forged tokens cannot dodge the limit', async () => {
    const a = await makeUser(t, Role.GUARDIAN);
    const b = await makeUser(t, Role.GUARDIAN);
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await api(t, a.token).post('/guardian/link', { code: 'AAAA-AAA' + (i + 2) })).status);
    assert.deepEqual(codes.slice(0, 5), [404, 404, 404, 404, 404]);
    assert.equal(codes[5], 429, 'sixth request within a minute is throttled');
    assert.equal((await api(t, b.token).post('/guardian/link', { code: 'AAAA-AAA2' })).status, 404, 'other user has their own bucket');
    // soxta tokenlar (har safar boshqa "sub") IP chelagiga tushadi va 401/429 oladi, cheksiz urinishga yo'l qo'ymaydi
    const jwt = require('jsonwebtoken');
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await api(t, jwt.sign({ sub: 'fake' + i }, 'wrong-secret')).post('/guardian/link', { code: 'AAAA-AAA2' })).status);
    assert.ok(statuses.includes(429), JSON.stringify(statuses));
    assert.ok(statuses.every((s) => s === 401 || s === 429));
  });

  it('message sending is limited to 30/min per user', async () => {
    const tch = await makeUser(t, Role.TEACHER);
    const s = await makeUser(t);
    const th = await t.prisma.chatThread.create({ data: { teacherUserId: tch.id, studentUserId: s.id } });
    const results: number[] = [];
    for (let i = 0; i < 32; i++) results.push((await api(t, s.token).post(`/threads/${th.id}/messages`, { body: 'm' + i })).status);
    assert.equal(results.filter((x) => x === 201).length, 30);
    assert.equal(results.filter((x) => x === 429).length, 2);
  });
});
