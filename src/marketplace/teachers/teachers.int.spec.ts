import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import {
  api, checkRouteMatrix, createTestApp, GOOD_PROFILE, isDenied, makeAdmin, makeFile, makeTeacher, makeUser, TestApp,
} from '../testing/harness';

describe('teacher profiles (integration)', () => {
  let t: TestApp;
  let admin: { id: string; token: string };
  before(async () => {
    t = await createTestApp();
    admin = await makeAdmin(t);
  });
  after(async () => {
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
      { method: 'GET', path: '/teachers/me/profile', allowed: ['TEACHER'] },
      { method: 'PUT', path: '/teachers/me/profile', body: {}, allowed: ['TEACHER'] },
      { method: 'GET', path: '/teachers/me/availability', allowed: ['TEACHER'] },
      { method: 'PUT', path: '/teachers/me/availability', body: { rules: [] }, allowed: ['TEACHER'] },
      { method: 'POST', path: '/teachers/me/submit', allowed: ['TEACHER'] },
      { method: 'GET', path: '/teachers/me/credentials', allowed: ['TEACHER'] },
      { method: 'GET', path: '/teachers/' + id, allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'GET', path: '/admin/market/teachers/queue', scope: 'admin', allowed: ['ADMIN'] },
      { method: 'POST', path: '/admin/market/teachers/' + id + '/approve', scope: 'admin', allowed: ['ADMIN'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('validation: price range, unknown subject, intro video host, mass assignment', async () => {
    const u = await makeUser(t, Role.TEACHER);
    const c = api(t, u.token);
    assert.equal((await c.put('/teachers/me/profile', { priceMinor: 1 })).status, 400);
    assert.equal((await c.put('/teachers/me/profile', { subjects: ['astrology'] })).status, 400);
    assert.equal((await c.put('/teachers/me/profile', { introVideoUrl: 'https://evil.example/x.mp4' })).status, 400);
    assert.equal((await c.put('/teachers/me/profile', { verificationStatus: 'VERIFIED' })).status, 400);
    assert.equal((await c.put('/teachers/me/profile', { ratingBayes: 5 })).status, 400);
    assert.equal((await c.put('/teachers/me/profile', { ...GOOD_PROFILE, introVideoUrl: 'https://youtu.be/abc' })).status, 200);
  });

  it('availability: replaces rules, rejects overlaps and bad times', async () => {
    const u = await makeUser(t, Role.TEACHER);
    const c = api(t, u.token);
    await c.put('/teachers/me/profile', GOOD_PROFILE);
    assert.equal((await c.put('/teachers/me/availability', { rules: [{ weekday: 1, start: '09:00', end: '12:00' }, { weekday: 1, start: '11:00', end: '13:00' }] })).status, 400);
    assert.equal((await c.put('/teachers/me/availability', { rules: [{ weekday: 1, start: '09:07', end: '12:00' }] })).status, 400);
    const ok = await c.put('/teachers/me/availability', { rules: [{ weekday: 2, start: '10:00', end: '12:00' }] });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, [{ weekday: 2, start: '10:00', end: '12:00' }]);
  });

  it('verification flow: incomplete cannot submit; unverified invisible; admin approves; verified is visible and safe', async () => {
    const u = await makeUser(t, Role.TEACHER);
    const c = api(t, u.token);
    await c.put('/teachers/me/profile', { headline: 'Hi' });
    const bad = await c.post('/teachers/me/submit');
    assert.equal(bad.status, 400);
    assert.ok(bad.body.missing.includes('credentials'));

    const { user, profileId } = await makeTeacher(t, { submit: true });
    const student = await makeUser(t, Role.STUDENT);
    assert.ok(isDenied((await api(t, student.token).get('/teachers/' + profileId)).status), 'PENDING must be hidden');

    const queue = await api(t, admin.token).get('/admin/market/teachers/queue');
    assert.ok(queue.body.some((r: any) => r.id === profileId));

    // o'qituvchi o'zini tasdiqlay olmaydi
    assert.equal((await api(t, user.token).post('/admin/market/teachers/' + profileId + '/approve')).status, 401);
    const approved = await api(t, admin.token).post('/admin/market/teachers/' + profileId + '/approve');
    assert.equal(approved.status, 200);
    assert.equal(approved.body.verificationStatus, 'VERIFIED');
    assert.equal((await api(t, admin.token).post('/admin/market/teachers/' + profileId + '/approve')).status, 409);

    const pub = await api(t, student.token).get('/teachers/' + profileId);
    assert.equal(pub.status, 200);
    assert.equal(pub.body.verified, true);
    assert.ok(!JSON.stringify(pub.body).includes(user.email), 'email must not leak');
    assert.ok(!('userId' in pub.body));
    assert.deepEqual(pub.body.credentials, [{ kind: 'DEGREE', title: 'BSc Mathematics' }]);

    const rows = await t.prisma.auditLog.findMany({ where: { targetId: profileId, action: 'teacher.approve' } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actorType, 'ADMIN');
  });

  it('reject needs a reason; teacher can fix and resubmit', async () => {
    const { user, profileId } = await makeTeacher(t, { submit: true });
    assert.equal((await api(t, admin.token).post('/admin/market/teachers/' + profileId + '/reject', {})).status, 400);
    const r = await api(t, admin.token).post('/admin/market/teachers/' + profileId + '/reject', { reason: 'Blurry diploma' });
    assert.equal(r.body.verificationStatus, 'REJECTED');
    const own = await api(t, user.token).get('/teachers/me/profile');
    assert.equal(own.body.rejectionReason, 'Blurry diploma');
    assert.equal((await api(t, user.token).post('/teachers/me/submit')).body.verificationStatus, 'PENDING');
  });

  it('suspension hides the profile again', async () => {
    const { profileId } = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const s = await makeUser(t);
    assert.equal((await api(t, s.token).get('/teachers/' + profileId)).status, 200);
    await api(t, admin.token).post('/admin/market/teachers/' + profileId + '/suspend', { reason: 'Complaint' });
    assert.ok(isDenied((await api(t, s.token).get('/teachers/' + profileId)).status));
  });

  it('IDOR: teacher B cannot attach A file, remove A credential or time-off', async () => {
    const a = await makeTeacher(t);
    const b = await makeUser(t, Role.TEACHER);
    const cb = api(t, b.token);
    await cb.put('/teachers/me/profile', GOOD_PROFILE);
    const fileA = await makeFile(t, a.user.id);
    assert.equal((await cb.post('/teachers/me/credentials', { kind: 'DEGREE', title: 'stolen', fileId: fileA.id })).status, 404);

    const credsA = await api(t, a.user.token).get('/teachers/me/credentials');
    assert.equal((await cb.del('/teachers/me/credentials/' + credsA.body[0].id)).status, 404);
    assert.equal((await api(t, a.user.token).get('/teachers/me/credentials')).body.length, 1);

    const to = await api(t, a.user.token).post('/teachers/me/time-off', { startAt: '2027-01-01T00:00:00Z', endAt: '2027-01-02T00:00:00Z' });
    assert.equal(to.status, 201);
    assert.equal((await cb.del('/teachers/me/time-off/' + to.body.id)).status, 404);
  });

  it('credential files must be READY, owned and of CREDENTIAL purpose', async () => {
    const u = await makeUser(t, Role.TEACHER);
    const c = api(t, u.token);
    await c.put('/teachers/me/profile', GOOD_PROFILE);
    const pending = await makeFile(t, u.id, { status: 'PENDING_UPLOAD' });
    assert.equal((await c.post('/teachers/me/credentials', { kind: 'DEGREE', title: 'x', fileId: pending.id })).status, 409);
    const quarantined = await makeFile(t, u.id, { status: 'QUARANTINED' });
    assert.equal((await c.post('/teachers/me/credentials', { kind: 'DEGREE', title: 'x', fileId: quarantined.id })).status, 409);
    const wrong = await makeFile(t, u.id, { purpose: 'AVATAR' });
    assert.equal((await c.post('/teachers/me/credentials', { kind: 'DEGREE', title: 'x', fileId: wrong.id })).status, 400);
  });

  it('students cannot create teacher profiles', async () => {
    const s = await makeUser(t, Role.STUDENT);
    assert.equal((await api(t, s.token).put('/teachers/me/profile', GOOD_PROFILE)).status, 403);
  });
});
