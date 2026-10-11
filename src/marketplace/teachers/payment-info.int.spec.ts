import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { ClockService } from '../common/clock';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makeTeacher, makeUser, TestApp, TestUser } from '../testing/harness';

const NOW = new Date('2026-11-02T00:00:00Z');
const CARD = '4111 1111 1111 1111';
const DIGITS = '4111111111111111';
let n = 0;

describe('teacher card details (A2, integration)', () => {
  let t: TestApp;
  let clock: ClockService;
  let admin: { id: string; token: string };

  const teacher = async (opts: { instant?: boolean; card?: boolean } = {}) => {
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    await api(t, x.user.token).put('/teachers/me/profile', { instantBooking: opts.instant ?? true });
    if (opts.card !== false) assert.equal((await api(t, x.user.token).put('/teachers/me/payment-info', { cardNumber: CARD, holderName: 'Ali Valiyev' })).status, 200);
    return x;
  };
  const book = async (u: TestUser, profileId: string, extra: object = {}) => {
    const days = ['03', '04', '05', '06', '09', '10', '11', '12'];
    const k = n++;
    const startAt = `2026-11-${days[k % 8]}T${String(4 + (Math.floor(k / 8) % 8)).padStart(2, '0')}:00:00.000Z`;
    const r = await api(t, u.token).post('/bookings', { teacherId: profileId, startAt, durationMin: 60, ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  const reveal = (u: TestUser, profileId: string) => api(t, u.token).post(`/teachers/${profileId}/payment-info/reveal`, {});

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
    const failures = await checkRouteMatrix(t, actors, [
      { method: 'PUT', path: '/teachers/me/payment-info', body: { cardNumber: 'x', holderName: 'y' }, allowed: ['TEACHER'] },
      { method: 'GET', path: '/teachers/me/payment-info', allowed: ['TEACHER'] },
      { method: 'DELETE', path: '/teachers/me/payment-info', allowed: ['TEACHER'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('validation: only a Luhn-valid 16-digit number and a 2-40 letter holder; CVV, expiry and anything else are rejected', async () => {
    const x = await teacher({ card: false });
    const c = api(t, x.user.token);
    for (const cardNumber of ['4111 1111 1111 1112', '411111111111111', '4111 1111 1111 1111 12/27', '4111********1111', '']) {
      const r = await c.put('/teachers/me/payment-info', { cardNumber, holderName: 'Ali Valiyev' });
      assert.equal(r.status, 400, cardNumber);
    }
    for (const holderName of ['A', 'Ali123', '12/27', 'x'.repeat(41)]) assert.equal((await c.put('/teachers/me/payment-info', { cardNumber: CARD, holderName })).status, 400, holderName);
    for (const extra of [{ cvv: '123' }, { expiry: '12/27' }, { cvc: '123' }, { smsCode: '1234' }, { pin: '1234' }]) {
      assert.equal((await c.put('/teachers/me/payment-info', { cardNumber: CARD, holderName: 'Ali Valiyev', ...extra })).status, 400, JSON.stringify(extra));
    }
    assert.equal(await t.prisma.teacherPaymentInfo.count({ where: { teacherId: x.profileId } }), 0, 'nothing stored after rejections');
    const ok = await c.put('/teachers/me/payment-info', { cardNumber: CARD, holderName: 'Ali Valiyev' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { set: true, cardLast4: '1111', holderName: 'Ali Valiyev' });
  });

  it('only teachers edit; students cannot; the number is stored encrypted, never in plain text', async () => {
    const x = await teacher();
    const row = await t.prisma.teacherPaymentInfo.findUniqueOrThrow({ where: { teacherId: x.profileId } });
    assert.ok(!row.cardNumberEnc.includes(DIGITS) && !row.cardNumberEnc.includes('4111'), 'ciphertext does not contain the number');
    assert.match(row.cardNumberEnc, /^v1\./);
    assert.equal(row.cardLast4, '1111');
    const raw = JSON.stringify(await t.prisma.$queryRawUnsafe(`SELECT * FROM "TeacherPaymentInfo" WHERE "teacherId" = '${x.profileId}'`));
    assert.ok(!raw.includes(DIGITS));
    assert.equal((await api(t, (await makeUser(t)).token).put('/teachers/me/payment-info', { cardNumber: CARD, holderName: 'Ali Valiyev' })).status, 403);
    // egasi to'liq raqamni qayta ko'rmaydi (faqat oxirgi 4 ta)
    assert.deepEqual((await api(t, x.user.token).get('/teachers/me/payment-info')).body, { set: true, cardLast4: '1111', holderName: 'Ali Valiyev' });
    assert.equal(JSON.stringify((await api(t, x.user.token).get('/teachers/me/payment-info')).body).includes(DIGITS), false);
    // o'zgartirish va o'chirish
    assert.equal((await api(t, x.user.token).put('/teachers/me/payment-info', { cardNumber: '5555 5555 5555 4444', holderName: 'Vali Aliyev' })).body.cardLast4, '4444');
    assert.deepEqual((await api(t, x.user.token).del('/teachers/me/payment-info')).body, { set: false });
  });

  it('reveal: pupil (or linked guardian) with an ACCEPTED non-trial booking only; everyone else gets 403', async () => {
    const x = await teacher();
    const pupil = await makeUser(t);
    const other = await makeUser(t);
    const otherTeacher = await teacher();
    assert.equal((await reveal(pupil, x.profileId)).status, 403, 'no booking at all');
    await book(pupil, x.profileId); // instant => CONFIRMED
    const r = await reveal(pupil, x.profileId);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { cardNumber: CARD, holderName: 'Ali Valiyev' });
    assert.equal((await reveal(other, x.profileId)).status, 403, 'another pupil');
    assert.equal((await reveal(pupil, otherTeacher.profileId)).status, 403, 'booking with a different teacher does not help');
    assert.equal((await reveal(otherTeacher.user, x.profileId)).status, 403, 'teachers cannot reveal');
    assert.equal((await api(t, admin.token).post(`/teachers/${x.profileId}/payment-info/reveal`, {})).status, 401);
    assert.equal((await api(t).post(`/teachers/${x.profileId}/payment-info/reveal`, {})).status, 401);
    assert.ok(await t.prisma.auditLog.findFirst({ where: { actorId: pupil.id, action: 'payment_info.reveal' } }));
    assert.ok(!JSON.stringify(await t.prisma.auditLog.findMany({ where: { action: { startsWith: 'payment_info' } } })).includes(DIGITS), 'audit log never holds the number');
  });

  it('not accepted / not payable bookings do not unlock the card: requested, declined, expired, cancelled, no-show-teacher, failed, trial', async () => {
    const x = await teacher({ instant: false }); // so'rov rejimi
    const s = await makeUser(t);
    const id = await book(s, x.profileId);
    assert.equal((await t.prisma.booking.findUniqueOrThrow({ where: { id } })).status, 'REQUESTED');
    assert.equal((await reveal(s, x.profileId)).status, 403, 'REQUESTED');
    await api(t, x.user.token).post(`/bookings/${id}/decline`, {});
    assert.equal((await reveal(s, x.profileId)).status, 403, 'DECLINED');
    for (const status of ['EXPIRED', 'CANCELLED', 'NO_SHOW_TEACHER', 'FAILED'] as const) {
      await t.prisma.booking.update({ where: { id }, data: { status } });
      assert.equal((await reveal(s, x.profileId)).status, 403, status);
    }
    for (const status of ['CONFIRMED', 'COMPLETED', 'NO_SHOW_STUDENT'] as const) {
      await t.prisma.booking.update({ where: { id }, data: { status } });
      assert.equal((await reveal(s, x.profileId)).status, 200, status);
    }
    await t.prisma.booking.update({ where: { id }, data: { isTrial: true } });
    assert.equal((await reveal(s, x.profileId)).status, 403, 'trial lessons never reveal the card');
  });

  it('linked guardian of a minor can reveal; an unlinked guardian or a revoked link cannot', async () => {
    const x = await teacher();
    const guardian = await makeUser(t, Role.GUARDIAN);
    const stranger = await makeUser(t, Role.GUARDIAN);
    const minor = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05' });
    await t.prisma.guardianLink.create({ data: { guardianId: guardian.id, studentId: minor.id, status: 'ACTIVE' } });
    await book(guardian, x.profileId, { studentId: minor.id });
    assert.equal((await reveal(guardian, x.profileId)).status, 200);
    assert.equal((await reveal(stranger, x.profileId)).status, 403);
    assert.equal((await reveal(minor, x.profileId)).status, 200, 'the pupil (minor) may see it too, to show a parent');
    // vasiy rezervni tuzgan emas, faqat bog'langan bo'lsa: yangi vasiy bog'lansa ham ko'ra oladi
    const g2 = await makeUser(t, Role.GUARDIAN);
    assert.equal((await reveal(g2, x.profileId)).status, 403);
    await t.prisma.guardianLink.create({ data: { guardianId: g2.id, studentId: minor.id, status: 'ACTIVE' } });
    assert.equal((await reveal(g2, x.profileId)).status, 200);
    await t.prisma.guardianLink.updateMany({ where: { guardianId: g2.id }, data: { status: 'REVOKED' } });
    assert.equal((await reveal(g2, x.profileId)).status, 403);
  });

  it('missing card => 404 NO_PAYMENT_INFO (after eligibility); public profile only says whether details exist', async () => {
    const x = await teacher({ card: false });
    const s = await makeUser(t);
    await book(s, x.profileId);
    const r = await reveal(s, x.profileId);
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'NO_PAYMENT_INFO');
    assert.equal((await api(t, s.token).get('/teachers/' + x.profileId)).body.paymentInfoAvailable, false);
    await api(t, x.user.token).put('/teachers/me/payment-info', { cardNumber: CARD, holderName: 'Ali Valiyev' });
    assert.equal((await api(t, s.token).get('/teachers/' + x.profileId)).body.paymentInfoAvailable, true);
  });

  it('the card number and its last digits never appear in any other response (profile, search, reviews, bookings, chat, notifications, export, calls, admin)', async () => {
    const x = await teacher();
    const s = await makeUser(t);
    const bookingId = await book(s, x.profileId);
    const th = (await api(t, s.token).post('/threads', { bookingId })).body;
    await api(t, s.token).post(`/threads/${th.id}/messages`, { body: 'salom' });
    await api(t, x.user.token).post(`/threads/${th.id}/messages`, { body: 'javob' });
    const calls: [string, string][] = [
      ['pupil', `/teachers/${x.profileId}`], ['pupil', `/teachers/${x.profileId}/reviews`], ['pupil', '/teachers?pageSize=50'], ['pupil', `/teachers/${x.profileId}/slots?from=2026-11-03T00:00:00Z&to=2026-11-04T00:00:00Z`],
      ['pupil', '/bookings?from=2026-11-01T00:00:00Z&to=2026-12-31T00:00:00Z'], ['pupil', `/bookings/${bookingId}`], ['pupil', '/threads'], ['pupil', `/threads/${th.id}/messages`],
      ['pupil', '/notifications'], ['pupil', '/me/export'], ['pupil', `/calls/${bookingId}/lobby`], ['pupil', '/safety/tips'],
      ['teacher', '/teachers/me/profile'], ['teacher', '/teachers/me/payment-info'], ['teacher', '/me/export'], ['teacher', '/bookings?from=2026-11-01T00:00:00Z&to=2026-12-31T00:00:00Z'],
      ['teacher', '/threads'], ['teacher', `/threads/${th.id}/messages`], ['teacher', '/notifications'], ['teacher', `/calls/${bookingId}/lobby`],
      ['admin', `/admin/market/teachers/${x.profileId}`], ['admin', '/admin/market/teachers/queue?status=VERIFIED&take=100'], ['admin', '/admin/market/audit?take=100'], ['admin', '/admin/market/reports'],
    ];
    const tok = { pupil: s.token, teacher: x.user.token, admin: admin.token } as Record<string, string>;
    for (const [who, path] of calls) {
      const r = await fetch(t.baseUrl + path, { headers: { authorization: 'Bearer ' + tok[who] } });
      const text = await r.text();
      assert.ok(r.status < 500, `${who} ${path} -> ${r.status}`);
      assert.ok(!text.includes(DIGITS) && !text.includes(CARD) && !text.includes('4111 1111'), `${who} ${path} leaked the card number`);
      if (who !== 'teacher') assert.ok(!text.includes('"cardLast4"'), `${who} ${path} exposes card digits`);
    }
    // bildirishnoma matnlari ham raqamsiz (generik shablon)
    assert.ok(!JSON.stringify(await t.prisma.notification.findMany({ where: { userId: { in: [s.id, x.user.id] } } })).includes(DIGITS));
  });

  it('reveal is limited to 20 per hour per user (429), other users are unaffected', async () => {
    const tt = await createTestApp([], { throttle: true });
    try {
      const adm = await makeAdmin(tt);
      const clk = tt.app.get(ClockService);
      clk.set(NOW);
      const tch = await makeTeacher(tt, { approve: { adminToken: adm.token } });
      await api(tt, tch.user.token).put('/teachers/me/profile', { instantBooking: true });
      await api(tt, tch.user.token).put('/teachers/me/payment-info', { cardNumber: CARD, holderName: 'Ali Valiyev' });
      const s1 = await makeUser(tt);
      const s2 = await makeUser(tt);
      for (const s of [s1, s2]) {
        const r = await api(tt, s.token).post('/bookings', { teacherId: tch.profileId, startAt: s === s1 ? '2026-11-03T05:00:00.000Z' : '2026-11-04T05:00:00.000Z', durationMin: 60 });
        assert.equal(r.status, 201);
      }
      const statuses: number[] = [];
      for (let i = 0; i < 22; i++) statuses.push((await api(tt, s1.token).post(`/teachers/${tch.profileId}/payment-info/reveal`, {})).status);
      assert.equal(statuses.filter((s) => s === 200).length, 20);
      assert.equal(statuses.filter((s) => s === 429).length, 2);
      assert.equal((await api(tt, s2.token).post(`/teachers/${tch.profileId}/payment-info/reveal`, {})).status, 200, 'per-user bucket');
      clk.set(null);
    } finally {
      await tt.close();
    }
  });

  it('in production without APP_DATA_KEY the feature is OFF with a clear error (never plain-text storage)', async () => {
    const x = await teacher({ card: false });
    const prevEnv = process.env.NODE_ENV;
    const prevKey = process.env.APP_DATA_KEY;
    delete process.env.APP_DATA_KEY;
    process.env.NODE_ENV = 'production';
    try {
      const r = await api(t, x.user.token).put('/teachers/me/payment-info', { cardNumber: CARD, holderName: 'Ali Valiyev' });
      assert.equal(r.status, 503);
      assert.equal(r.body.code, 'CARD_FEATURE_DISABLED');
      assert.equal((await reveal(await makeUser(t), x.profileId)).status, 503);
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevKey !== undefined) process.env.APP_DATA_KEY = prevKey;
    }
    assert.equal(await t.prisma.teacherPaymentInfo.count({ where: { teacherId: x.profileId } }), 0);
  });

  it('deleting the teacher account erases the card details', async () => {
    const x = await teacher();
    assert.equal(await t.prisma.teacherPaymentInfo.count({ where: { teacherId: x.profileId } }), 1);
    assert.equal((await api(t, x.user.token).post('/me/delete', { confirm: 'DELETE' })).status, 200);
    assert.equal(await t.prisma.teacherPaymentInfo.count({ where: { teacherId: x.profileId } }), 0);
  });
});
