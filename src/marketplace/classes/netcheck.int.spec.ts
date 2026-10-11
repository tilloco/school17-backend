import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makeTeacher, makeUser, TestApp } from '../testing/harness';

describe('network pre-check endpoints (R4)', () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp([], { throttle: true });
  });
  after(async () => {
    await t.close();
  });

  it('route matrix: any signed-in user, nobody anonymous', async () => {
    const admin = await makeAdmin(t);
    const actors = { STUDENT: await makeUser(t, Role.STUDENT), GUARDIAN: await makeUser(t, Role.GUARDIAN), TEACHER: (await makeTeacher(t, { approve: { adminToken: admin.token } })).user, adminToken: admin.token };
    const failures = await checkRouteMatrix(t, actors, [
      { method: 'GET', path: '/netcheck/down', allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'POST', path: '/netcheck/up', body: { pad: 'x' }, allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('download returns a fixed-size body, upload accepts bounded input, oversize is refused, and the rate is limited', async () => {
    const u = await makeUser(t);
    const d = await fetch(t.baseUrl + '/netcheck/down', { headers: { authorization: 'Bearer ' + u.token } });
    assert.equal(d.status, 200);
    assert.equal((await d.arrayBuffer()).byteLength, 128 * 1024);
    assert.equal(d.headers.get('cache-control'), 'no-store');
    assert.equal((await api(t, u.token).post('/netcheck/up', { pad: 'a'.repeat(60_000) })).body.received, 60_000);
    assert.equal((await api(t, u.token).post('/netcheck/up', { pad: 'a'.repeat(70_000) })).status, 400);
    const v = await makeUser(t);
    const codes: number[] = [];
    for (let i = 0; i < 65; i++) codes.push((await api(t, v.token).post('/netcheck/up', { pad: 'x' })).status);
    assert.ok(codes.includes(429), 'abuse limit');
    assert.equal(codes.slice(0, 60).every((c) => c === 200), true);
  });
});
