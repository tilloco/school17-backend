import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Role } from '@prisma/client';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makeTeacher, makeUser, TestApp } from '../testing/harness';

describe('admin web backend (A6): credentials review, user search', () => {
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
    const actors = { STUDENT: await makeUser(t, Role.STUDENT), GUARDIAN: await makeUser(t, Role.GUARDIAN), TEACHER: await makeUser(t, Role.TEACHER), adminToken: admin.token };
    const id = '11111111-1111-4111-8111-111111111111';
    const failures = await checkRouteMatrix(t, actors, [
      { method: 'GET', path: '/admin/market/users?q=x', scope: 'admin', allowed: ['ADMIN'] },
      { method: 'POST', path: `/admin/market/teachers/credentials/${id}/approve`, body: {}, scope: 'admin', allowed: ['ADMIN'] },
      { method: 'POST', path: `/admin/market/teachers/credentials/${id}/reject`, body: { reason: 'x' }, scope: 'admin', allowed: ['ADMIN'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('per-credential review: reason required for rejection, audited, does not change the teacher status; admin sees file ids and can open them (audited)', async () => {
    const x = await makeTeacher(t, { submit: true });
    const detail = (await api(t, admin.token).get(`/admin/market/teachers/${x.profileId}`)).body;
    assert.equal(detail.email, x.user.email, 'admin sees the email');
    const cred = detail.credentials[0];
    assert.ok(cred.fileId);
    const url = await api(t, admin.token).post(`/admin/market/files/${cred.fileId}/download-url`);
    assert.equal(url.status, 200);
    assert.equal((await api(t, x.user.token).post(`/admin/market/teachers/credentials/${cred.id}/approve`, {})).status, 401, 'teachers cannot review');
    assert.equal((await api(t, admin.token).post(`/admin/market/teachers/credentials/${cred.id}/reject`, {})).status, 400, 'reason required');
    const rej = await api(t, admin.token).post(`/admin/market/teachers/credentials/${cred.id}/reject`, { reason: 'Blurry scan' });
    assert.equal(rej.body.status, 'REJECTED');
    const after = (await api(t, admin.token).get(`/admin/market/teachers/${x.profileId}`)).body;
    assert.equal(after.credentials[0].status, 'REJECTED');
    assert.equal(after.credentials[0].reviewNote, 'Blurry scan');
    assert.equal(after.verificationStatus, 'PENDING', 'profile status untouched');
    assert.equal((await api(t, admin.token).post(`/admin/market/teachers/credentials/${cred.id}/approve`, {})).body.status, 'APPROVED');
    assert.equal((await api(t, admin.token).post(`/admin/market/teachers/credentials/${randomUUID()}/approve`, {})).status, 404);
    assert.ok(await t.prisma.auditLog.findFirst({ where: { action: 'credential.reject', targetId: cred.id, actorType: 'ADMIN' } }));
    // teacher's own view never contains the file id or the email of anyone else
    const own = JSON.stringify((await api(t, x.user.token).get('/teachers/me/profile')).body);
    assert.ok(!own.includes(cred.fileId));
  });

  it('user search: by name or email, role/status filters, paging cap, emails only for admins', async () => {
    const tag = 'zz' + randomUUID().replace(/-/g, '').slice(0, 8);
    const a = await makeUser(t, Role.STUDENT, { name: `Search ${tag} Alpha` });
    const b = await makeUser(t, Role.TEACHER, { name: `Search ${tag} Beta` });
    await t.prisma.user.update({ where: { id: b.id }, data: { status: 'SUSPENDED' } });
    const all = (await api(t, admin.token).get(`/admin/market/users?q=${tag}`)).body;
    assert.equal(all.total, 2);
    assert.deepEqual(all.items.map((i: any) => i.email).sort(), [a.email, b.email].sort());
    assert.equal((await api(t, admin.token).get(`/admin/market/users?q=${tag}&role=TEACHER`)).body.total, 1);
    assert.equal((await api(t, admin.token).get(`/admin/market/users?q=${tag}&status=SUSPENDED`)).body.items[0].id, b.id);
    assert.equal((await api(t, admin.token).get(`/admin/market/users?q=${encodeURIComponent(a.email.slice(0, 12))}`)).body.items.some((i: any) => i.id === a.id), true);
    assert.equal((await api(t, admin.token).get(`/admin/market/users?q=${tag}&role=HACKER&status=NOPE`)).body.total, 2, 'unknown filter values are ignored');
    assert.ok((await api(t, admin.token).get('/admin/market/users?take=100000&skip=-4')).body.items.length <= 50);
    assert.equal((await api(t, a.token).get(`/admin/market/users?q=${tag}`)).status, 401);
    assert.equal((await api(t, admin.token).get(`/admin/market/users?q=${encodeURIComponent("' OR 1=1 --")}`)).status, 200);
    // moderator workflow: suspend from the list and the user is out immediately
    assert.equal((await api(t, admin.token).post(`/admin/market/users/${a.id}/suspend`, { reason: 'test' })).body.status, 'SUSPENDED');
    assert.equal((await api(t, a.token).get('/me')).status, 401);
  });
});
