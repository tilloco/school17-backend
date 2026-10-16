import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AuthModule } from './auth.module';
import { api, createTestApp, TestApp } from '../marketplace/testing/harness';

const email = () => `reg-${randomUUID().slice(0, 8)}@test.local`;
const good = (over: object = {}) => ({ email: email(), password: 'Correct-Horse-9', name: 'Ali Valiyev', role: 'STUDENT', dateOfBirth: '2001-04-05', acceptTerms: true, locale: 'ru', ...over });

describe('email + password sign-up and sign-in', () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp([AuthModule]);
  });
  after(async () => {
    await t.close();
  });

  it('registers each role with consents and returns a token that works on the API; passwords are only stored hashed', async () => {
    for (const [role, dob] of [['STUDENT', '2001-04-05'], ['TEACHER', '1990-01-01'], ['GUARDIAN', '1985-06-06']] as const) {
      const body = good({ role, dateOfBirth: dob });
      const r = await api(t).post('/auth/email/register', body);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const me = await api(t, r.body.accessToken).get('/me');
      assert.equal(me.status, 200);
      assert.equal(me.body.role, role);
      assert.equal(me.body.locale, 'ru');
      const u = await t.prisma.user.findUniqueOrThrow({ where: { email: body.email.toLowerCase() }, include: { consents: true } });
      assert.ok(u.passwordHash && u.passwordHash !== body.password && u.passwordHash.startsWith('$2'), 'bcrypt hash');
      assert.deepEqual(u.consents.map((c) => c.kind).sort(), role === 'GUARDIAN' ? ['GUARDIAN_STATEMENT', 'PRIVACY', 'TERMS'] : ['PRIVACY', 'TERMS']);
      assert.equal(u.emailVerifiedAt, null, 'an e-mail with a password is not verified');
    }
  });

  it('validates input: terms, password strength, age by role, duplicate e-mail, admin role, extra fields', async () => {
    const post = (b: object) => api(t).post('/auth/email/register', b);
    assert.equal((await post(good({ acceptTerms: false }))).body.code, 'TERMS_REQUIRED');
    assert.equal((await post(good({ password: 'short' }))).status, 400);
    assert.equal((await post(good({ password: 'x'.repeat(73) }))).status, 400, 'bcrypt silently ignores bytes beyond 72');
    assert.equal((await post(good({ password: 'password' }))).body.code, 'WEAK_PASSWORD');
    assert.equal((await post(good({ password: 'aaaaaaaaaa' }))).body.code, 'WEAK_PASSWORD');
    assert.equal((await post(good({ dateOfBirth: '2020-01-01' }))).body.code, 'TOO_YOUNG', 'pupils must be 10 or older');
    assert.equal((await post(good({ role: 'TEACHER', dateOfBirth: '2012-01-01' }))).body.code, 'TOO_YOUNG', 'teachers must be adults');
    assert.equal((await post(good({ role: 'GUARDIAN', dateOfBirth: '2010-01-01' }))).body.code, 'TOO_YOUNG');
    assert.equal((await post(good({ dateOfBirth: '2999-01-01' }))).status >= 400, true);
    assert.equal((await post(good({ dateOfBirth: 'yesterday' }))).status, 400);
    assert.equal((await post(good({ role: 'ADMIN' }))).status, 400, 'nobody can sign up as admin');
    assert.equal((await post(good({ email: 'not-an-email' }))).status, 400);
    assert.equal((await post({ ...good(), isPremium: true, referralCode: 'x' })).status, 400, 'unknown fields are refused');
    const first = good();
    assert.equal((await post(first)).status, 201);
    assert.equal((await post({ ...first, email: first.email.toUpperCase() })).body.code, 'EMAIL_TAKEN', 'e-mail match is case-insensitive');
  });

  it('sign-in: right password works (any letter case in the e-mail), wrong ones get one generic answer, 5 failures lock the account for 15 minutes', async () => {
    const b = good();
    await api(t).post('/auth/email/register', b);
    const login = (e: string, p: string) => api(t).post('/auth/email/login', { email: e, password: p });
    const ok = await login(b.email.toUpperCase(), b.password);
    assert.equal(ok.status, 200);
    assert.equal((await api(t, ok.body.accessToken).get('/me')).status, 200);
    const wrongPw = await login(b.email, 'Wrong-Password-1');
    const noUser = await login(email(), 'Whatever-123');
    assert.equal(wrongPw.status, 401);
    assert.deepEqual(wrongPw.body, noUser.body, 'no hint whether the e-mail exists');
    for (let i = 0; i < 4; i++) await login(b.email, 'Wrong-Password-1');
    const locked = await login(b.email, b.password);
    assert.equal(locked.status, 429, 'the right password is also refused while locked');
    assert.equal(locked.body.code, 'ACCOUNT_LOCKED');
    await t.prisma.user.update({ where: { email: b.email.toLowerCase() }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    assert.equal((await login(b.email, b.password)).status, 200, 'works again once the lock has passed');
    assert.equal((await t.prisma.user.findUniqueOrThrow({ where: { email: b.email.toLowerCase() } })).loginFailCount, 0);
  });

  it('suspended accounts cannot sign in; accounts without a password (Google) cannot sign in with one', async () => {
    const b = good();
    await api(t).post('/auth/email/register', b);
    await t.prisma.user.update({ where: { email: b.email.toLowerCase() }, data: { status: 'SUSPENDED' } });
    assert.equal((await api(t).post('/auth/email/login', { email: b.email, password: b.password })).status, 401);
    const g = email();
    await t.prisma.user.create({ data: { email: g, name: 'G', referralCode: 'G' + randomUUID().slice(0, 8), emailVerifiedAt: new Date() } });
    assert.equal((await api(t).post('/auth/email/login', { email: g, password: 'Anything-12345' })).status, 401);
  });

  it('abuse limits: sign-up and sign-in are rate limited per client', async () => {
    const th = await createTestApp([AuthModule], { throttle: true });
    try {
      const reg: number[] = [];
      for (let i = 0; i < 8; i++) reg.push((await api(th).post('/auth/email/register', good({ password: 'x' }))).status);
      assert.ok(reg.includes(429), 'register: ' + reg.join(','));
      const login: number[] = [];
      for (let i = 0; i < 14; i++) login.push((await api(th).post('/auth/email/login', { email: email(), password: 'nope-nope-1' })).status);
      assert.ok(login.includes(429), 'login: ' + login.join(','));
    } finally {
      await th.close();
    }
  });
});
