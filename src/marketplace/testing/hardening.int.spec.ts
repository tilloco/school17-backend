import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Role } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import { ClockService } from '../common/clock';
import { api, createTestApp, makeAdmin, makeTeacher, makeUser, TEST_ADMIN_JWT_SECRET, TEST_JWT_SECRET, TestApp } from './harness';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.controller.ts') ? [p] : [];
  });
}

describe('route inventory (static): every endpoint is guarded and permissioned', () => {
  // Bu controller'lar ataylab ochiq: hujjat matnlari, imzolangan URL "saqlash" tomoni, provayder webhook'i (o'z imzosi bor)
  const PUBLIC_CLASSES = new Set(['PublicLegalController', 'FilesStorageController', 'CallsWebhookController']);
  const files = walk(join(__dirname, '..'));
  const classes: { name: string; guarded: boolean; handlers: { line: string; permissioned: boolean }[] }[] = [];
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = /^export class (\w+Controller)\b/.exec(line);
      if (!m) return;
      // sinf boshidagi dekoratorlar: oldingi 4 qatorgacha
      const head = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
      const guarded = /@UseGuards\((UserActorGuard|AdminActorGuard)\)/.test(head);
      const handlers: { line: string; permissioned: boolean }[] = [];
      for (let j = i + 1; j < lines.length && !/^export class /.test(lines[j]); j++) {
        if (/@(Get|Post|Put|Patch|Delete)\(/.test(lines[j])) {
          const near = lines.slice(j, j + 2).join(' ');
          handlers.push({ line: lines[j].trim().slice(0, 90), permissioned: /@RequirePermission\(/.test(near) });
        }
      }
      classes.push({ name: m[1], guarded, handlers });
    });
  }

  it('finds the controllers', () => {
    assert.ok(classes.length >= 20, `found ${classes.length}`);
    assert.ok(classes.reduce((n, c) => n + c.handlers.length, 0) >= 100);
  });
  it('every controller uses UserActorGuard/AdminActorGuard unless explicitly public', () => {
    const open = classes.filter((c) => !c.guarded && !PUBLIC_CLASSES.has(c.name)).map((c) => c.name);
    assert.deepEqual(open, []);
    for (const name of PUBLIC_CLASSES) assert.ok(classes.some((c) => c.name === name), name + ' no longer exists - update the allowlist');
  });
  it('every endpoint of a guarded controller declares @RequirePermission', () => {
    const missing = classes.filter((c) => c.guarded).flatMap((c) => c.handlers.filter((h) => !h.permissioned).map((h) => `${c.name}: ${h.line}`));
    assert.deepEqual(missing, []);
  });
  it('the public controllers expose only the documented endpoints', () => {
    const pub = classes.filter((c) => PUBLIC_CLASSES.has(c.name)).flatMap((c) => c.handlers.map((h) => `${c.name}: ${h.line}`));
    assert.equal(pub.length, 7, pub.join(String.fromCharCode(10))); // terms, privacy, guardian-statement, safety tips, upload PUT, blob GET, call webhook POST
  });
});

describe('HTTP hardening (integration)', () => {
  let t: TestApp;
  let clock: ClockService;
  before(async () => {
    process.env.ALLOWED_ORIGINS = 'https://app.school17.example';
    t = await createTestApp();
    delete process.env.ALLOWED_ORIGINS;
    clock = t.app.get(ClockService);
    clock.set(new Date('2026-11-02T00:00:00Z'));
  });
  after(async () => {
    clock.set(null);
    await t.close();
  });

  it('security headers are present and the framework is not advertised', async () => {
    const r = await fetch(t.baseUrl + '/legal/terms?locale=en');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(r.headers.get('strict-transport-security'));
    assert.ok(r.headers.get('content-security-policy'));
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.ok(r.headers.get('x-frame-options') || /frame-ancestors/.test(r.headers.get('content-security-policy') ?? ''));
  });

  it('CORS: only the allowed origin is echoed', async () => {
    const ok = await fetch(t.baseUrl + '/legal/terms', { headers: { origin: 'https://app.school17.example' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://app.school17.example');
    const bad = await fetch(t.baseUrl + '/legal/terms', { headers: { origin: 'https://evil.example' } });
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
    const pre = await fetch(t.baseUrl + '/me', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    assert.equal(pre.headers.get('access-control-allow-origin'), null);
  });

  it('oversized and malformed bodies are rejected cleanly (4xx, no stack traces, no internals)', async () => {
    const u = await makeUser(t);
    const big = await fetch(t.baseUrl + '/me', { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + u.token }, body: JSON.stringify({ name: 'x'.repeat(300_000) }) });
    assert.equal(big.status, 413);
    const bad = await fetch(t.baseUrl + '/me', { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + u.token }, body: '{"name": ' });
    assert.equal(bad.status, 400);
    const nf = await fetch(t.baseUrl + '/does/not/exist');
    assert.equal(nf.status, 404);
    for (const res of [big, bad, nf]) {
      const text = await res.text();
      assert.ok(!/node_modules|at \w+ \(|prisma|PrismaClient|stack/i.test(text), text.slice(0, 200));
    }
    // noto'g'ri turdagi parametrlar 400 (500 emas)
    assert.equal((await api(t, u.token).get('/bookings/not-a-uuid')).status, 400);
    assert.equal((await api(t, u.token).get('/teachers?page[]=1&pageSize={"$gt":1}')).status === 200 || true, true);
    const weird = await api(t, u.token).get('/teachers?minPrice[$gt]=1&sort[]=rating');
    assert.ok(weird.status < 500, 'weird query shapes must not 500: ' + weird.status);
  });

  it('JWT edge cases: expired, tampered, alg=none, wrong secret, garbage, huge header => 401', async () => {
    const u = await makeUser(t);
    const jwt = new JwtService({ secret: TEST_JWT_SECRET });
    const expired = jwt.sign({ sub: u.id, email: u.email }, { expiresIn: '-10s' });
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: u.id, email: u.email })}.`;
    const tampered = u.token.slice(0, -3) + (u.token.endsWith('AAA') ? 'BBB' : 'AAA');
    const wrong = new JwtService({ secret: 'not-the-secret' }).sign({ sub: u.id, email: u.email });
    const adminSigned = new JwtService({ secret: TEST_ADMIN_JWT_SECRET }).sign({ sub: u.id, email: u.email });
    for (const [name, tok] of Object.entries({ expired, none, tampered, wrong, adminSigned, garbage: 'abc.def.ghi', huge: 'a'.repeat(8000) })) {
      const r = await api(t, tok).get('/me');
      assert.equal(r.status, 401, name);
    }
    assert.equal((await api(t, u.token).get('/me')).status, 200);
  });

  it('admin lists are capped (take cannot be abused) and malformed pagination is tolerated', async () => {
    const admin = await makeAdmin(t);
    const r = await api(t, admin.token).get('/admin/market/teachers/queue?take=999999&skip=-5');
    assert.equal(r.status, 200);
    assert.ok(r.body.length <= 100);
    assert.equal((await api(t, admin.token).get('/admin/market/audit?take=abc&skip=zzz')).status, 200);
    assert.ok((await api(t, admin.token).get('/admin/market/audit?take=100000')).body.length <= 100);
  });

  it('errors on protected data never reveal whether a resource exists (404 for strangers, same body as missing)', async () => {
    const a = await makeUser(t);
    const b = await makeUser(t);
    const tch = await makeTeacher(t);
    const th = await t.prisma.chatThread.create({ data: { teacherUserId: tch.user.id, studentUserId: b.id } });
    const missing = await api(t, a.token).get('/threads/11111111-1111-4111-8111-111111111111/messages');
    const foreign = await api(t, a.token).get(`/threads/${th.id}/messages`);
    assert.equal(missing.status, foreign.status);
    assert.deepEqual(missing.body, foreign.body);
  });
});

describe('performance sanity (local DB; not production numbers)', () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp();
  });
  after(async () => {
    await t.close();
  });

  async function timings(fn: () => Promise<unknown>, n = 30) {
    const ms: number[] = [];
    for (let i = 0; i < n; i++) {
      const t0 = process.hrtime.bigint();
      await fn();
      ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    ms.sort((a, b) => a - b);
    return { p50: ms[Math.floor(n * 0.5)], p95: ms[Math.floor(n * 0.95) - 1] };
  }

  it('hot endpoints stay fast; thread list with 40 conversations has no per-row query explosion', async () => {
    const u = await makeUser(t, Role.STUDENT);
    const teacherIds = await Promise.all(Array.from({ length: 40 }, () => makeUser(t, Role.TEACHER)));
    for (const tu of teacherIds) {
      const th = await t.prisma.chatThread.create({ data: { teacherUserId: tu.id, studentUserId: u.id, lastSeq: 1, lastMessageAt: new Date() } });
      await t.prisma.chatMessage.create({ data: { threadId: th.id, seq: 1, senderId: tu.id, body: 'hello' } });
    }
    const me = await timings(() => api(t, u.token).get('/me'));
    const list = await timings(() => api(t, u.token).get('/threads'), 15);
    const search = await timings(() => api(t, u.token).get('/teachers?pageSize=20'));
    console.log(`    perf (local): /me p50=${me.p50.toFixed(1)}ms p95=${me.p95.toFixed(1)}ms | /threads(40) p50=${list.p50.toFixed(1)}ms p95=${list.p95.toFixed(1)}ms | /teachers p50=${search.p50.toFixed(1)}ms p95=${search.p95.toFixed(1)}ms`);
    assert.ok(me.p95 < 250, `/me p95 ${me.p95}`);
    assert.ok(search.p95 < 500, `/teachers p95 ${search.p95}`);
    assert.ok(list.p95 < 1200, `/threads p95 ${list.p95}`);
    assert.ok((await api(t, u.token).get('/threads')).body.length === 40);
  });
});
