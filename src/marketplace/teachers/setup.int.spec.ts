import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { ClockService } from '../common/clock';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makeJpeg, makeTeacher, makeUser, TestApp, TestUser, uploadFile } from '../testing/harness';

const NOW = new Date('2026-11-02T00:00:00Z');
let n = 0;
const when = () => {
  const days = ['03', '04', '05', '06', '09', '10', '11', '12'];
  const k = n++;
  return `2026-11-${days[k % 8]}T${String(4 + (Math.floor(k / 8) % 6) * 1).padStart(2, '0')}:00:00.000Z`;
};

describe('teacher setup backend gaps (A5): photo, counter-offer, money summary', () => {
  let t: TestApp;
  let clock: ClockService;
  let admin: { id: string; token: string };

  const teacher = async (instant = true, approve = true) => {
    const x = approve ? await makeTeacher(t, { approve: { adminToken: admin.token } }) : await makeTeacher(t, { submit: true });
    await api(t, x.user.token).put('/teachers/me/profile', { instantBooking: instant });
    return x;
  };

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
      { method: 'PUT', path: '/teachers/me/photo', body: { fileId: id }, allowed: ['TEACHER'] },
      { method: 'DELETE', path: '/teachers/me/photo', allowed: ['TEACHER'] },
      { method: 'GET', path: `/teachers/${id}/photo`, allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'GET', path: '/teachers/me/money/summary', allowed: ['TEACHER'] },
      { method: 'POST', path: `/bookings/${id}/counter-offer`, body: { startAt: '2026-11-10T05:00:00.000Z' }, allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('profile photo: own image only, thumbnail served to everyone for VERIFIED teachers, to the owner before verification; never inline', async () => {
    const x = await teacher();
    const pupil = await makeUser(t);
    const other = await teacher();
    const img = await uploadFile(t, x.user, { mime: 'image/jpeg', bytes: await makeJpeg(400, 300, true), purpose: 'AVATAR', name: 'me.jpg' });
    assert.equal(img.complete.status, 200);
    assert.equal((await api(t, x.user.token).put('/teachers/me/photo', { fileId: img.fileId })).body.hasPhoto, true);
    assert.equal((await api(t, pupil.token).get(`/teachers/${x.profileId}`)).body.hasPhoto, true);
    const res = await fetch(t.baseUrl + `/teachers/${x.profileId}/photo`, { headers: { authorization: 'Bearer ' + pupil.token } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/webp');
    assert.match(res.headers.get('content-disposition')!, /^attachment/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const sharp = require('sharp');
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    assert.ok(meta.width! <= 320);
    assert.equal(meta.exif, undefined);
    assert.equal((await api(t, pupil.token).get(`/teachers/${other.profileId}/photo`)).status, 404, 'no photo');
    assert.equal((await fetch(t.baseUrl + `/teachers/${x.profileId}/photo`)).status, 401, 'anonymous');

    // IDOR / validation
    const theirs = await uploadFile(t, other.user, { mime: 'image/jpeg', bytes: await makeJpeg(50, 50, false), purpose: 'AVATAR' });
    assert.equal((await api(t, x.user.token).put('/teachers/me/photo', { fileId: theirs.fileId })).status, 404);
    const wrong = await uploadFile(t, x.user, { mime: 'image/jpeg', bytes: await makeJpeg(50, 50, false), purpose: 'MESSAGE_ATTACHMENT' });
    assert.equal((await api(t, x.user.token).put('/teachers/me/photo', { fileId: wrong.fileId })).status, 400);
    const pending = await uploadFile(t, x.user, { mime: 'image/jpeg', bytes: await makeJpeg(50, 50, false), purpose: 'AVATAR', noComplete: true });
    assert.equal((await api(t, x.user.token).put('/teachers/me/photo', { fileId: pending.fileId })).status, 409);
    assert.equal((await api(t, pupil.token).put('/teachers/me/photo', { fileId: img.fileId })).status, 403);

    // tasdiqlanmagan o'qituvchi: faqat o'zi ko'radi; olib tashlansa 404
    const draft = await makeUser(t, Role.TEACHER);
    const di = await uploadFile(t, draft, { mime: 'image/jpeg', bytes: await makeJpeg(50, 50, false), purpose: 'AVATAR' });
    const prof = await api(t, draft.token).put('/teachers/me/profile', { headline: 'Hello tutor' });
    await api(t, draft.token).put('/teachers/me/photo', { fileId: di.fileId });
    assert.equal((await api(t, draft.token).get(`/teachers/${prof.body.id}/photo`)).status, 200);
    assert.equal((await api(t, pupil.token).get(`/teachers/${prof.body.id}/photo`)).status, 404, 'unverified teachers are invisible');
    await api(t, x.user.token).del('/teachers/me/photo');
    assert.equal((await api(t, pupil.token).get(`/teachers/${x.profileId}/photo`)).status, 404);
  });

  it('counter-offer on a pending request: teacher only, pupil accepts => confirmed at the new time with a payment mark; rejects => stays pending', async () => {
    const x = await teacher(false);
    const s = await makeUser(t);
    const orig = when();
    const newTime = when();
    const b = (await api(t, s.token).post('/bookings', { teacherId: x.profileId, startAt: orig, durationMin: 60 })).body;
    assert.equal(b.status, 'REQUESTED');
    assert.equal((await api(t, s.token).post(`/bookings/${b.id}/counter-offer`, { startAt: newTime })).status, 404, 'pupil cannot counter-offer');
    assert.equal((await api(t, (await teacher()).user.token).post(`/bookings/${b.id}/counter-offer`, { startAt: newTime })).status, 404, 'other teacher');
    const co = await api(t, x.user.token).post(`/bookings/${b.id}/counter-offer`, { startAt: newTime });
    assert.equal(co.status, 200, JSON.stringify(co.body));
    assert.equal(co.body.status, 'REQUESTED');
    assert.equal(co.body.reschedule.proposedStartAt, newTime);
    assert.ok(await t.prisma.notification.findFirst({ where: { userId: s.id, type: 'booking.counter_offer' } }));
    assert.equal((await api(t, x.user.token).post(`/bookings/${b.id}/reschedule/accept`)).status, 403, 'proposer cannot accept own offer');
    assert.equal((await api(t, s.token).post(`/bookings/${b.id}/reschedule/reject`)).body.status, 'REQUESTED');
    assert.equal((await api(t, s.token).get(`/bookings/${b.id}`)).body.reschedule, null);
    await api(t, x.user.token).post(`/bookings/${b.id}/counter-offer`, { startAt: newTime });
    const acc = await api(t, s.token).post(`/bookings/${b.id}/reschedule/accept`);
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    assert.equal(acc.body.status, 'CONFIRMED');
    assert.equal(acc.body.startAt, newTime);
    assert.equal((await t.prisma.directPayment.findUniqueOrThrow({ where: { bookingId: b.id } })).status, 'UNPAID', 'acceptance creates the payment mark');
    assert.equal((await api(t, x.user.token).post(`/bookings/${b.id}/counter-offer`, { startAt: when() })).status, 409, 'already confirmed');
  });

  it('counter-offer is validated: free slot, notice, expiry', async () => {
    const x = await teacher(false);
    const s = await makeUser(t);
    const s2 = await makeUser(t);
    const mine = when();
    const busyAt = when();
    const b = (await api(t, s.token).post('/bookings', { teacherId: x.profileId, startAt: mine, durationMin: 60 })).body;
    await api(t, s2.token).post('/bookings', { teacherId: x.profileId, startAt: busyAt, durationMin: 60 });
    assert.equal((await api(t, x.user.token).post(`/bookings/${b.id}/counter-offer`, { startAt: busyAt })).status, 409, 'slot taken');
    assert.equal((await api(t, x.user.token).post(`/bookings/${b.id}/counter-offer`, { startAt: '2026-11-02T00:30:00.000Z' })).status, 400, 'too soon');
    assert.equal((await api(t, x.user.token).post(`/bookings/${b.id}/counter-offer`, { startAt: '2026-11-03T02:00:00.000Z' })).status, 409, 'outside availability');
    const ok = when();
    await api(t, x.user.token).post(`/bookings/${b.id}/counter-offer`, { startAt: ok });
    clock.set(new Date(NOW.getTime() + 25 * 3_600_000));
    assert.equal((await api(t, s.token).post(`/bookings/${b.id}/reschedule/accept`)).status, 409, 'expired requests cannot be accepted');
    clock.set(NOW);
  });

  it('money summary counts unpaid past lessons and payments awaiting confirmation (teacher only, own data)', async () => {
    const x = await teacher();
    const other = await teacher();
    const s = await makeUser(t);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await api(t, s.token).post('/bookings', { teacherId: x.profileId, startAt: when(), durationMin: 60 })).body.id);
    await t.prisma.booking.update({ where: { id: ids[0] }, data: { status: 'COMPLETED', completedAt: NOW } });
    await t.prisma.booking.update({ where: { id: ids[1] }, data: { status: 'NO_SHOW_STUDENT' } });
    await api(t, s.token).post(`/bookings/${ids[2]}/direct-payment/paid`, {});
    const sum = await api(t, x.user.token).get('/teachers/me/money/summary');
    assert.deepEqual(sum.body, { unpaidLessons: 2, awaitingConfirmation: 1 });
    assert.deepEqual((await api(t, other.user.token).get('/teachers/me/money/summary')).body, { unpaidLessons: 0, awaitingConfirmation: 0 });
    await api(t, x.user.token).post(`/bookings/${ids[0]}/direct-payment/received`, {});
    assert.equal((await api(t, x.user.token).get('/teachers/me/money/summary')).body.unpaidLessons, 1);
    assert.equal((await api(t, s.token).get('/teachers/me/money/summary')).status, 403);
  });
});

export type _Unused = TestUser;
