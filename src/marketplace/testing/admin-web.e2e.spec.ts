// Haqiqiy admin veb-panel (Next.js production build) + haqiqiy backend (test ilovasi, vaqtinchalik DB) bilan oxirigacha sinov.
// Ishga tushiriladigan jarayon faqat shu test boshlagan `next start` va test oxirida to'xtatiladi. admin/.next bo'lmasa o'tkazib yuboriladi.
import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { ClockService } from '../common/clock';
import { AdminAuthModule } from '../../admin-auth/admin-auth.module';
import { OBJECT_STORAGE } from '../files/storage';
import { api, createTestApp, makePdf, makeTeacher, makeThread, makeUser, TestApp } from './harness';

const ADMIN_DIR = join(__dirname, '..', '..', '..', '..', 'admin');
const BUILT = existsSync(join(ADMIN_DIR, '.next', 'BUILD_ID'));
const PORT = 3101;
const WEB = `http://127.0.0.1:${PORT}`;

describe('admin web panel end-to-end (real Next build)', { skip: BUILT ? false : 'admin/.next is missing: run `npm run build` in admin/' }, () => {
  let t: TestApp;
  let proc: ChildProcess;
  let cookie = '';
  const password = 'S3cret-' + randomUUID().slice(0, 8);
  let email = '';
  const get = (path: string, headers: Record<string, string> = {}, redirect: RequestRedirect = 'manual') => fetch(WEB + path, { headers: { cookie, ...headers }, redirect });
  const post = (path: string, body: object = {}, headers: Record<string, string> = {}) =>
    fetch(WEB + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie, ...headers }, body: JSON.stringify(body) });

  before(async () => {
    t = await createTestApp([AdminAuthModule]);
    email = `web-${randomUUID().slice(0, 8)}@test.local`;
    await t.prisma.admin.create({ data: { email, passwordHash: await bcrypt.hash(password, 4), role: 'SUPERADMIN' } as any });
    proc = spawn(process.execPath, [join(ADMIN_DIR, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(PORT)], {
      cwd: ADMIN_DIR,
      env: { ...process.env, BACKEND_URL: t.baseUrl, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' },
      stdio: process.env.ADMIN_E2E_LOGS ? 'inherit' : 'ignore',
    });
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(WEB + '/login');
        if (r.status === 200) break;
      } catch {
        /* hali ishga tushmadi */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const login = await post('/api/login', { email, password });
    assert.equal(login.status, 200, 'admin can log in through the web panel');
    const setCookie = login.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /admin_token=/);
    assert.match(setCookie, /HttpOnly/i, 'token cookie is httpOnly');
    cookie = setCookie.split(';')[0] + '; lang=en';
  });
  after(async () => {
    t?.app.get(ClockService).set(null);
    proc?.kill();
    await t?.close();
  });

  it('requires login: anonymous visitors are redirected, wrong password is rejected', async () => {
    const r = await fetch(WEB + '/teachers', { redirect: 'manual' });
    assert.ok([302, 303, 307, 308].includes(r.status));
    assert.match(r.headers.get('location') ?? '', /\/login/);
    assert.equal((await post('/api/login', { email, password: 'wrong-password-123' }, { cookie: '' })).status, 401);
  });

  it('verification queue shows a pending teacher; the detail page escapes hostile text; approve works through the proxy; document opens via a signed link', async () => {
    const x = await makeTeacher(t, { submit: true });
    await api(t, x.user.token).put('/teachers/me/profile', { bio: '<img src=x onerror=alert(1)> I teach mathematics for many years, patiently and with joy.' });
    const list = await (await get('/teachers?status=PENDING')).text();
    assert.ok(list.includes('Experienced math tutor'), 'queue lists the teacher');
    assert.ok(list.includes('Teacher verification queue'), 'English strings from the language cookie');
    const detail = await (await get('/teachers/' + x.profileId)).text();
    assert.ok(detail.includes(x.user.email));
    assert.ok(!detail.includes('<img src=x onerror'), 'raw HTML from the profile must never be rendered');
    assert.ok(detail.includes('&lt;img src=x onerror'), 'it appears escaped');
    assert.ok(detail.includes('Open document'));

    const fileId = (await t.prisma.teacherCredential.findFirstOrThrow({ where: { teacherId: x.profileId } })).fileId;
    const fileRow = await t.prisma.storedFile.findUniqueOrThrow({ where: { id: fileId } });
    await (t.app.get(OBJECT_STORAGE) as any).put(`${fileRow.storageKey}/blob`, makePdf()); // makeTeacher yozuvi faqat DB'da: bayt qo'shamiz
    const du = await post(`/api/proxy/files/${fileId}/download-url`);
    assert.equal(du.status, 200, await du.clone().text());
    const url = (await du.json()).url as string;
    assert.ok(url.startsWith(t.baseUrl), 'signed URL is made absolute for the browser');
    assert.equal((await fetch(url)).status, 200);

    const ap = await post(`/api/proxy/teachers/${x.profileId}/approve`);
    assert.equal(ap.status, 200);
    assert.equal((await ap.json()).verificationStatus, 'VERIFIED');
    assert.equal((await t.prisma.teacherProfile.findUniqueOrThrow({ where: { id: x.profileId } })).verificationStatus, 'VERIFIED');
    assert.ok((await (await get('/teachers?status=VERIFIED')).text()).includes('Experienced math tutor'));
  });

  it('the proxy only forwards allow-listed paths, requires the cookie, and rejects cross-site posts', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    assert.equal((await post('/api/proxy/users')).status, 404);
    assert.equal((await post('/api/proxy/audit')).status, 404);
    assert.equal((await post(`/api/proxy/teachers/${id}/delete`)).status, 404);
    assert.equal((await post('/api/proxy/..%2Fauth/login')).status, 404);
    assert.equal((await post(`/api/proxy/teachers/${id}/approve`, {}, { cookie: '' })).status, 401);
    assert.equal((await post(`/api/proxy/teachers/${id}/approve`, {}, { origin: 'https://evil.example' })).status, 403);
    assert.notEqual((await post(`/api/proxy/teachers/${id}/approve`, {}, { origin: WEB })).status, 403);
    assert.equal((await get(`/api/proxy/teachers/${id}/approve`)).status, 405, 'GET is not proxied');
    // money endpoints do not exist in the proxy or in the panel
    assert.equal((await post('/api/proxy/payouts/' + id + '/pay')).status, 404);
  });

  it('reports queue and people search: report -> resolve (suspends the user) -> user is out', async () => {
    const tch = await makeTeacher(t, { submit: true });
    const adminRow = await t.prisma.admin.findFirstOrThrow({ where: { email } });
    const adminTok = (await (await fetch(t.baseUrl + '/admin/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).accessToken as string;
    assert.ok(adminRow && adminTok);
    await api(t, adminTok).post(`/admin/market/teachers/${tch.profileId}/approve`);
    await api(t, tch.user.token).put('/teachers/me/profile', { instantBooking: true });
    const pupil = await makeUser(t);
    t.app.get(ClockService).set(new Date('2026-11-02T00:00:00Z'));
    const th = await makeThread(t, tch, pupil, '2026-11-03T05:00:00.000Z');
    {
      const rep = await api(t, pupil.token).post(`/threads/${th.threadId}/report`, { reason: 'PAYMENT_PROBLEM', note: 'sent money, no lesson <script>alert(1)</script>' });
      assert.equal(rep.status, 201);
      const page = await (await get('/reports')).text();
      assert.ok(page.includes('PAYMENT_PROBLEM'));
      assert.ok(!page.includes('<script>alert(1)</script>'), 'report text is escaped');
      const res = await post(`/api/proxy/reports/${rep.body.id}/resolve`, { action: 'ACTION', note: 'ok' });
      assert.equal(res.status, 200);
      assert.equal((await api(t, tch.user.token).get('/me')).status, 401, 'reported teacher was suspended');
    }
    const people = await (await get('/people?q=' + encodeURIComponent(pupil.email.slice(0, 10)))).text();
    assert.ok(people.includes(pupil.email));
    const sus = await post(`/api/proxy/users/${pupil.id}/suspend`, { reason: 'test' });
    assert.equal(sus.status, 200);
    assert.equal((await api(t, pupil.token).get('/me')).status, 401);
    assert.equal((await post(`/api/proxy/users/${pupil.id}/reinstate`)).status, 200);
    assert.equal((await api(t, pupil.token).get('/me')).status, 200);
  });
});
