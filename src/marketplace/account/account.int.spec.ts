import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makeUser, TestApp, isDenied } from '../testing/harness';
import { ROLE_PERMISSIONS, PERMISSIONS } from '../common/permissions';
import { ageInYears } from '../common/actor';

describe('permissions table (pure)', () => {
  it('every permission is granted to at least one role', () => {
    for (const p of PERMISSIONS) {
      assert.ok(Object.values(ROLE_PERMISSIONS).some((s) => s.has(p)), p);
    }
  });
  it('admin cannot book or join calls; students cannot review verification', () => {
    assert.equal(ROLE_PERMISSIONS.ADMIN.has('booking.create'), false);
    assert.equal(ROLE_PERMISSIONS.ADMIN.has('call.join'), false);
    assert.equal(ROLE_PERMISSIONS.STUDENT.has('teacher.verification.review'), false);
    assert.equal(ROLE_PERMISSIONS.TEACHER.has('payout.review'), false);
  });
  it('ageInYears handles birthdays', () => {
    assert.equal(ageInYears(new Date('2008-06-15'), new Date('2026-06-14')), 17);
    assert.equal(ageInYears(new Date('2008-06-15'), new Date('2026-06-15')), 18);
  });
});

describe('account + authorization (integration, throwaway DB)', () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp();
  });
  after(async () => {
    await t.close();
  });

  it('route matrix: roles and token kinds', async () => {
    const actors = {
      STUDENT: await makeUser(t, Role.STUDENT),
      GUARDIAN: await makeUser(t, Role.GUARDIAN),
      TEACHER: await makeUser(t, Role.TEACHER),
      adminToken: (await makeAdmin(t)).token,
    };
    const failures = await checkRouteMatrix(t, actors, [
      { method: 'GET', path: '/me', allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'GET', path: '/admin/market/audit', scope: 'admin', allowed: ['ADMIN'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('user A only ever sees own account', async () => {
    const a = await makeUser(t);
    const b = await makeUser(t);
    const res = await api(t, a.token).get('/me');
    assert.equal(res.status, 200);
    assert.equal(res.body.id, a.id);
    assert.notEqual(res.body.id, b.id);
    // yo'lda boshqa id berishning imkoni yo'q: /me/:id mavjud emas
    assert.ok(isDenied((await api(t, a.token).get(`/me/${b.id}`)).status));
  });

  it('suspended and deleted accounts are rejected even with a valid token', async () => {
    const s = await makeUser(t, Role.STUDENT, { status: 'SUSPENDED' });
    const d = await makeUser(t, Role.STUDENT, { status: 'DELETED' });
    assert.equal((await api(t, s.token).get('/me')).status, 401);
    assert.equal((await api(t, d.token).get('/me')).status, 401);
  });

  it('role switch: adults with DOB only, one-way, never to ADMIN', async () => {
    const adult = await makeUser(t);
    assert.equal((await api(t, adult.token).post('/me/role', { role: 'TEACHER' })).status, 201);
    assert.equal((await api(t, adult.token).get('/me')).body.role, 'TEACHER');
    const again = await api(t, adult.token).post('/me/role', { role: 'GUARDIAN' });
    assert.equal(again.status, 403); // endi o'quvchi emas

    const noDob = await makeUser(t, Role.STUDENT, { dateOfBirth: null });
    assert.equal((await api(t, noDob.token).post('/me/role', { role: 'TEACHER' })).status, 403);

    const minor = await makeUser(t, Role.STUDENT, { dateOfBirth: new Date(Date.now() - 15 * 365.25 * 864e5).toISOString().slice(0, 10) });
    assert.equal((await api(t, minor.token).post('/me/role', { role: 'TEACHER' })).status, 403);

    const u = await makeUser(t);
    assert.equal((await api(t, u.token).post('/me/role', { role: 'ADMIN' })).status, 400);
  });

  it('date of birth can be set once; under-13 rejected; invalid timezone rejected', async () => {
    const u = await makeUser(t, Role.STUDENT, { dateOfBirth: null });
    assert.equal((await api(t, u.token).patch('/me', { dateOfBirth: '2020-01-01' })).status, 403);
    assert.equal((await api(t, u.token).patch('/me', { timezone: 'Mars/Base' })).status, 400);
    assert.equal((await api(t, u.token).patch('/me', { locale: 'de' })).status, 400);
    const ok = await api(t, u.token).patch('/me', { dateOfBirth: '2010-05-05', timezone: 'Asia/Samarkand', locale: 'ru' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.isMinor, true);
    assert.equal((await api(t, u.token).patch('/me', { dateOfBirth: '1990-01-01' })).status, 403);
  });

  it('mass assignment: role/status cannot be set through PATCH /me', async () => {
    const u = await makeUser(t);
    const res = await api(t, u.token).patch('/me', { role: 'ADMIN' });
    assert.equal(res.status, 400); // forbidNonWhitelisted
    assert.equal((await api(t, u.token).get('/me')).body.role, 'STUDENT');
  });

  it('role switch is written to the audit log; secrets are scrubbed', async () => {
    const u = await makeUser(t);
    await api(t, u.token).post('/me/role', { role: 'TEACHER' });
    const rows = await t.prisma.auditLog.findMany({ where: { actorId: u.id, action: 'account.role_switch' } });
    assert.equal(rows.length, 1);
    const { scrubMetadata } = await import('../common/audit.service');
    assert.deepEqual(scrubMetadata({ apiKey: 'abc', token: 'x', ok: 1 }), { apiKey: '[redacted]', token: '[redacted]', ok: 1 });
  });
});
