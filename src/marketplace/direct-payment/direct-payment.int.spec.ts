import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { ClockService } from '../common/clock';
import { DomainEvents } from '../common/events';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makeJpeg, makePdf, makeTeacher, makeThread, makeUser, TestApp, TestUser, uploadFile } from '../testing/harness';

const NOW = new Date('2026-11-02T00:00:00Z');
let n = 0;

describe('direct payment tracking (A3, integration)', () => {
  let t: TestApp;
  let clock: ClockService;
  let admin: { id: string; token: string };
  let events: DomainEvents;

  const teacher = async (instant = true) => {
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    await api(t, x.user.token).put('/teachers/me/profile', { instantBooking: instant });
    return x;
  };
  const when = () => {
    const days = ['03', '04', '05', '06', '09', '10', '11', '12'];
    const k = n++;
    return `2026-11-${days[k % 8]}T${String(4 + (Math.floor(k / 8) % 8)).padStart(2, '0')}:00:00.000Z`;
  };
  const book = async (u: TestUser, profileId: string, extra: object = {}) => {
    const r = await api(t, u.token).post('/bookings', { teacherId: profileId, startAt: when(), durationMin: 60, ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  const dp = (u: TestUser, id: string) => api(t, u.token).get(`/bookings/${id}/direct-payment`);
  const act = (u: TestUser, id: string, what: 'paid' | 'received' | 'not-received' | 'waive', body: object = {}) => api(t, u.token).post(`/bookings/${id}/direct-payment/${what}`, body);
  const status = async (id: string) => (await t.prisma.directPayment.findUniqueOrThrow({ where: { bookingId: id } })).status;

  before(async () => {
    t = await createTestApp();
    clock = t.app.get(ClockService);
    clock.set(NOW);
    admin = await makeAdmin(t);
    events = t.app.get(DomainEvents);
  });
  after(async () => {
    clock.set(null);
    await t.close();
  });

  it('route matrix', async () => {
    const actors = { STUDENT: await makeUser(t, Role.STUDENT), GUARDIAN: await makeUser(t, Role.GUARDIAN), TEACHER: await makeUser(t, Role.TEACHER), adminToken: admin.token };
    const id = '11111111-1111-4111-8111-111111111111';
    const failures = await checkRouteMatrix(t, actors, [
      { method: 'GET', path: `/bookings/${id}/direct-payment`, allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'POST', path: `/bookings/${id}/direct-payment/paid`, body: {}, allowed: ['STUDENT', 'GUARDIAN'] },
      { method: 'POST', path: `/bookings/${id}/direct-payment/received`, body: {}, allowed: ['TEACHER'] },
      { method: 'POST', path: `/bookings/${id}/direct-payment/not-received`, body: {}, allowed: ['TEACHER'] },
      { method: 'POST', path: `/bookings/${id}/direct-payment/waive`, body: {}, allowed: ['TEACHER'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('a record with the price snapshot appears when the lesson is ACCEPTED (instant or on accept), never before; price changes do not touch it', async () => {
    const instant = await teacher(true);
    const s = await makeUser(t);
    const id1 = await book(s, instant.profileId);
    const v = (await dp(s, id1)).body;
    assert.equal(v.status, 'UNPAID');
    assert.equal(v.amountMinor, 5_000_000);
    await api(t, instant.user.token).put('/teachers/me/profile', { priceMinor: 9_000_000 });
    assert.equal((await dp(s, id1)).body.amountMinor, 5_000_000, 'snapshot');

    const manual = await teacher(false);
    const id2 = await book(s, manual.profileId);
    assert.equal(await t.prisma.directPayment.count({ where: { bookingId: id2 } }), 0, 'REQUESTED: nothing yet');
    assert.equal((await dp(s, id2)).body.status, null);
    assert.equal((await act(s, id2, 'paid')).status, 409);
    await api(t, manual.user.token).post(`/bookings/${id2}/accept`);
    assert.equal(await status(id2), 'UNPAID');
    // rad etilgan so'rovga hech qachon yozuv bo'lmaydi
    const id3 = await book(s, manual.profileId);
    await api(t, manual.user.token).post(`/bookings/${id3}/decline`, {});
    assert.equal(await t.prisma.directPayment.count({ where: { bookingId: id3 } }), 0);
  });

  it('trial lessons never get a payment record', async () => {
    const x = await teacher();
    const s = await makeUser(t);
    const id = await book(s, x.profileId);
    await t.prisma.directPayment.delete({ where: { bookingId: id } });
    await t.prisma.booking.update({ where: { id }, data: { isTrial: true } });
    const v = (await dp(s, id)).body;
    assert.equal(v.trial, true);
    assert.equal(await t.prisma.directPayment.count({ where: { bookingId: id } }), 0);
    const r = await act(s, id, 'paid');
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'TRIAL_FREE');
  });

  it('happy path: pupil marks paid (with receipt) -> teacher confirms; terminal afterwards', async () => {
    const x = await teacher();
    const s = await makeUser(t);
    const id = await book(s, x.profileId);
    const proof = await uploadFile(t, s, { mime: 'image/jpeg', bytes: await makeJpeg(40, 40, true), purpose: 'PAYMENT_PROOF', name: 'chek.jpg' });
    assert.equal(proof.complete.status, 200, JSON.stringify(proof.complete?.body));
    const paid = await act(s, id, 'paid', { proofFileId: proof.fileId });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.status, 'PUPIL_MARKED_PAID');
    assert.equal(paid.body.hasProof, true);
    assert.equal(paid.body.canMarkPaid, false);
    const tv = (await dp(x.user, id)).body;
    assert.equal(tv.canConfirm, true);
    assert.equal(tv.canMarkPaid, false);
    assert.ok(await t.prisma.notification.findFirst({ where: { userId: x.user.id, type: 'directpay.marked' } }));
    const done = await act(x.user, id, 'received');
    assert.equal(done.body.status, 'TEACHER_CONFIRMED');
    assert.ok(await t.prisma.notification.findFirst({ where: { userId: s.id, type: 'directpay.confirmed' } }));
    for (const w of ['paid', 'received', 'not-received', 'waive'] as const) assert.equal((await act(w === 'paid' ? s : x.user, id, w)).status, 409, w);
  });

  it('"not received" lets the pupil mark again; teacher can waive ("free this time")', async () => {
    const x = await teacher();
    const s = await makeUser(t);
    const id = await book(s, x.profileId);
    assert.equal((await act(x.user, id, 'not-received')).status, 409, 'cannot be "not received" before the pupil marked');
    await act(s, id, 'paid');
    assert.equal((await act(x.user, id, 'not-received')).body.status, 'NOT_RECEIVED');
    assert.ok(await t.prisma.notification.findFirst({ where: { userId: s.id, type: 'directpay.not_received' } }));
    assert.equal((await act(s, id, 'paid')).body.status, 'PUPIL_MARKED_PAID');
    await act(x.user, id, 'not-received');
    assert.equal((await act(x.user, id, 'waive')).body.status, 'WAIVED');
    const row = await t.prisma.directPayment.findUniqueOrThrow({ where: { bookingId: id } });
    assert.equal(row.waivedFrom, 'NOT_RECEIVED');
    assert.equal((await act(s, id, 'paid')).status, 409);
  });

  it('only the right side can act: teacher cannot mark paid, pupil cannot confirm/waive, strangers 404, admin 401', async () => {
    const x = await teacher();
    const other = await teacher();
    const s = await makeUser(t);
    const stranger = await makeUser(t);
    const id = await book(s, x.profileId);
    assert.equal((await act(x.user, id, 'paid')).status, 403, 'teacher has no directpay.mark');
    for (const w of ['received', 'not-received', 'waive'] as const) assert.equal((await act(s, id, w)).status, 403, w);
    assert.equal((await dp(stranger, id)).status, 404);
    assert.equal((await act(stranger, id, 'paid')).status, 404);
    assert.equal((await act(other.user, id, 'received')).status, 404, 'another teacher');
    assert.equal((await dp(other.user, id)).status, 404);
    for (const w of ['paid', 'received', 'waive'] as const) assert.equal((await api(t, admin.token).post(`/bookings/${id}/direct-payment/${w}`, {})).status, 401, 'admin cannot move payment marks');
    assert.equal(await status(id), 'UNPAID');
  });

  it('guardians: a linked guardian (or the booker) can mark paid for a minor; unlinked/revoked cannot', async () => {
    const x = await teacher();
    const guardian = await makeUser(t, Role.GUARDIAN);
    const stranger = await makeUser(t, Role.GUARDIAN);
    const minor = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05' });
    await t.prisma.guardianLink.create({ data: { guardianId: guardian.id, studentId: minor.id, status: 'ACTIVE' } });
    const id = await book(guardian, x.profileId, { studentId: minor.id });
    assert.equal((await dp(stranger, id)).status, 404);
    assert.equal((await act(stranger, id, 'paid')).status, 404);
    assert.equal((await act(guardian, id, 'paid')).body.status, 'PUPIL_MARKED_PAID');
    const g2 = await makeUser(t, Role.GUARDIAN);
    await t.prisma.guardianLink.create({ data: { guardianId: g2.id, studentId: minor.id, status: 'ACTIVE' } });
    assert.equal((await dp(g2, id)).status, 200, 'second linked guardian can see it');
    await t.prisma.guardianLink.updateMany({ where: { guardianId: g2.id }, data: { status: 'REVOKED' } });
    assert.equal((await dp(g2, id)).status, 404);
  });

  it('compare-and-set: concurrent conflicting actions let exactly one win', async () => {
    const x = await teacher();
    const s = await makeUser(t);
    const id = await book(s, x.profileId);
    const [a, b] = await Promise.all([act(x.user, id, 'received'), act(x.user, id, 'waive')]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const id2 = await book(s, x.profileId);
    const rs = await Promise.all(Array.from({ length: 5 }, () => act(s, id2, 'paid')));
    assert.equal(rs.filter((r) => r.status === 200).length, 1);
    assert.equal(rs.filter((r) => r.status === 409).length, 4);
  });

  it('automatic WAIVED: cancelled, teacher no-show, technical failure; pupil no-show stays UNPAID; confirmed payments are left alone', async () => {
    const x = await teacher();
    const s = await makeUser(t);
    const cancelled = await book(s, x.profileId);
    await api(t, s.token).post(`/bookings/${cancelled}/cancel`);
    assert.equal(await status(cancelled), 'WAIVED');
    assert.equal((await t.prisma.directPayment.findUniqueOrThrow({ where: { bookingId: cancelled } })).waivedReason, 'cancelled');

    const tns = await book(s, x.profileId);
    await act(s, tns, 'paid');
    await events.emit('booking.noshow', { bookingId: tns, kind: 'NO_SHOW_TEACHER' });
    const r = await t.prisma.directPayment.findUniqueOrThrow({ where: { bookingId: tns } });
    assert.equal(r.status, 'WAIVED');
    assert.equal(r.waivedFrom, 'PUPIL_MARKED_PAID', 'we remember the pupil had marked it');

    const failed = await book(s, x.profileId);
    await events.emit('booking.failed', { bookingId: failed, note: 'x' });
    assert.equal(await status(failed), 'WAIVED');

    const sns = await book(s, x.profileId);
    await events.emit('booking.noshow', { bookingId: sns, kind: 'NO_SHOW_STUDENT' });
    assert.equal(await status(sns), 'UNPAID');

    const confirmed = await book(s, x.profileId);
    await act(x.user, confirmed, 'received');
    await events.emit('booking.failed', { bookingId: confirmed, note: 'x' });
    assert.equal(await status(confirmed), 'TEACHER_CONFIRMED');
  });

  it('receipt rules: image only, max 5 MB, own file only, right purpose; visible only to pupil side, teacher and (audited) admin', async () => {
    const x = await teacher();
    const s = await makeUser(t);
    const outsider = await makeUser(t);
    const id = await book(s, x.profileId);
    const pdf = await api(t, s.token).post('/files/init', { purpose: 'PAYMENT_PROOF', name: 'a.pdf', size: 100, mime: 'application/pdf' });
    assert.equal(pdf.status, 400, 'PDF receipts are not accepted');
    const big = await api(t, s.token).post('/files/init', { purpose: 'PAYMENT_PROOF', name: 'a.jpg', size: 6 * 1024 * 1024, mime: 'image/jpeg' });
    assert.equal(big.status, 413);
    const theirs = await uploadFile(t, outsider, { mime: 'image/jpeg', bytes: await makeJpeg(30, 30, false), purpose: 'PAYMENT_PROOF' });
    assert.equal((await act(s, id, 'paid', { proofFileId: theirs.fileId })).status, 404, 'cannot attach someone else\'s file');
    const wrong = await uploadFile(t, s, { mime: 'image/jpeg', bytes: await makeJpeg(30, 30, false), purpose: 'MESSAGE_ATTACHMENT' });
    assert.equal((await act(s, id, 'paid', { proofFileId: wrong.fileId })).status, 400);
    const pending = await uploadFile(t, s, { mime: 'image/jpeg', bytes: await makeJpeg(30, 30, false), purpose: 'PAYMENT_PROOF', noComplete: true });
    assert.equal((await act(s, id, 'paid', { proofFileId: pending.fileId })).status, 409);
    assert.equal(await status(id), 'UNPAID', 'failed attempts changed nothing');

    const proof = await uploadFile(t, s, { mime: 'image/jpeg', bytes: await makeJpeg(30, 30, false), purpose: 'PAYMENT_PROOF' });
    await act(s, id, 'paid', { proofFileId: proof.fileId });
    assert.equal((await api(t, x.user.token).post(`/files/${proof.fileId}/download-url`, {})).status, 200, 'teacher sees the receipt');
    assert.equal((await api(t, s.token).post(`/files/${proof.fileId}/download-url`, {})).status, 200);
    assert.equal((await api(t, outsider.token).post(`/files/${proof.fileId}/download-url`, {})).status, 404);
    assert.equal((await api(t, (await teacher()).user.token).post(`/files/${proof.fileId}/download-url`, {})).status, 404, 'other teacher');
    assert.equal((await api(t, admin.token).post(`/admin/market/files/${proof.fileId}/download-url`)).status, 200);
    assert.ok(await t.prisma.auditLog.findFirst({ where: { action: 'file.admin_download', targetId: proof.fileId } }));
    assert.ok(makePdf);
  });

  it('paymentTiming is information only: validated, shown on profile, booking and payment views', async () => {
    const x = await teacher();
    const s = await makeUser(t);
    assert.equal((await api(t, x.user.token).put('/teachers/me/profile', { paymentTiming: 'WHENEVER' })).status, 400);
    assert.equal((await api(t, x.user.token).put('/teachers/me/profile', { paymentTiming: 'PAY_BEFORE' })).body.paymentTiming, 'PAY_BEFORE');
    assert.equal((await api(t, s.token).get(`/teachers/${x.profileId}`)).body.paymentTiming, 'PAY_BEFORE');
    const id = await book(s, x.profileId);
    assert.equal((await api(t, s.token).get(`/bookings/${id}`)).body.teacher.paymentTiming, 'PAY_BEFORE');
    const v = (await dp(s, id)).body;
    assert.equal(v.paymentTiming, 'PAY_BEFORE');
    assert.equal((await act(s, id, 'paid')).status, 200, 'timing does not block anything');
  });

  it('"payment problem" can be reported through the existing flow; the admin queue sees it but has no money endpoints', async () => {
    const x = await teacher();
    const s = await makeUser(t);
    const th = await makeThread(t, x, s, when());
    const rep = await api(t, s.token).post(`/threads/${th.threadId}/report`, { reason: 'PAYMENT_PROBLEM', note: 'sent money, no lesson' });
    assert.equal(rep.status, 201, JSON.stringify(rep.body));
    const q = (await api(t, admin.token).get('/admin/market/reports?take=100')).body as { id: string; reason: string }[];
    assert.equal(q.find((r) => r.id === rep.body.id)?.reason, 'PAYMENT_PROBLEM');
    for (const path of ['/admin/market/direct-payments', '/admin/market/payments/review']) assert.equal((await api(t, admin.token).get(path)).status, 404, path);
  });
});
