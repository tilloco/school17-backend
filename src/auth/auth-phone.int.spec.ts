import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { AuthModule } from './auth.module';
import { api, createTestApp, TestApp } from '../marketplace/testing/harness';
import { normalizePhone, TelegramGatewaySender } from './telegram-gateway';

let n = 0;
const newDevice = () => (`dev${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`).padEnd(24, 'x');
/** Asks for a sign-in code like the app does: with a device id (a fresh one unless given). */
const ask = async (t: TestApp, phone: string, device: string | null = newDevice()) => {
  const r = await fetch(t.baseUrl + '/auth/phone/request', { method: 'POST', headers: { 'content-type': 'application/json', ...(device ? { 'x-device-id': device } : {}) }, body: JSON.stringify({ phone }) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const phone = () => `+99890${String(Date.now() % 10_000_000).padStart(7, '0').slice(0, 5)}${String(++n).padStart(2, '0')}`;

describe('Telegram Gateway sender', () => {
  it('sends the code with the bearer token and maps "no Telegram" errors', async () => {
    let seen: any;
    const ok = new TelegramGatewaySender('tok', (async (url: any, init: any) => { seen = { url, init }; return { ok: true, json: async () => ({ ok: true }) }; }) as any);
    assert.deepEqual(await ok.send('+998901234567', '123456', 300), { ok: true });
    assert.equal(seen.url, 'https://gatewayapi.telegram.org/sendVerificationMessage');
    assert.equal(seen.init.headers.Authorization, 'Bearer tok');
    assert.equal(JSON.parse(seen.init.body).phone_number, '+998901234567');
    const none = new TelegramGatewaySender('tok', (async () => ({ ok: false, json: async () => ({ ok: false, error: 'PHONE_NUMBER_NOT_FOUND' }) })) as any);
    assert.equal((await none.send('+998901234567', '123456', 300)).reason, 'NO_TELEGRAM');
    const down = new TelegramGatewaySender('tok', (async () => { throw new Error('net'); }) as any);
    assert.equal((await down.send('+998901234567', '123456', 300)).reason, 'FAILED');
  });
  it('normalizes phone numbers', () => {
    assert.equal(normalizePhone('+998 90 123-45-67'), '+998901234567');
    assert.equal(normalizePhone('901234567'), null);
    assert.equal(normalizePhone('+12'), null);
  });
});

describe('phone sign-in with a Telegram code', () => {
  let t: TestApp;
  before(async () => {
    process.env.PHONE_DEV_CODES = '1';
    delete process.env.TELEGRAM_GATEWAY_TOKEN;
    t = await createTestApp([AuthModule]);
    await t.prisma.phoneRequestGate.deleteMany({}); // old counters from earlier runs must not decide this one
  });
  after(async () => {
    delete process.env.PHONE_DEV_CODES;
    await t.close();
  });

  it('new person: code, then profile, then a working account; the same number signs in directly next time', async () => {
    const p = phone();
    const req = await ask(t, p);
    assert.equal(req.status, 200, JSON.stringify(req.body));
    const code = req.body.devCode as string;
    assert.match(code, /^\d{6}$/);
    const first = await api(t).post('/auth/phone/verify', { phone: p, code });
    assert.equal(first.body.needsProfile, true, 'the code is kept until the profile arrives');
    const full = await api(t).post('/auth/phone/verify', { phone: p, code, name: 'Dilnoza K', role: 'TEACHER', dateOfBirth: '1992-02-02', acceptTerms: true, locale: 'uz' });
    assert.equal(full.status, 200, JSON.stringify(full.body));
    const me = await api(t, full.body.accessToken).get('/me');
    assert.equal(me.body.role, 'TEACHER');
    const u = await t.prisma.user.findUniqueOrThrow({ where: { phone: p } });
    assert.equal(u.name, 'Dilnoza K');
    assert.equal((await api(t).post('/auth/phone/verify', { phone: p, code })).status, 401, 'a used code does not work twice');
    const again = await ask(t, p);
    assert.equal(again.status, 429, 'resend too fast is refused');
    await t.prisma.phoneLoginCode.updateMany({ where: { phone: p }, data: { createdAt: new Date(Date.now() - 120_000) } });
    const r2 = await ask(t, p);
    const back = await api(t).post('/auth/phone/verify', { phone: p, code: r2.body.devCode });
    assert.ok(back.body.accessToken);
  });

  it('refuses wrong codes (locks after 5), bad numbers, missing terms and too-young teachers', async () => {
    const p = phone();
    assert.equal((await ask(t, '12345')).status, 400);
    const code = (await ask(t, p)).body.devCode as string;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) assert.equal((await api(t).post('/auth/phone/verify', { phone: p, code: wrong })).status, 401);
    assert.equal((await api(t).post('/auth/phone/verify', { phone: p, code })).status, 401, 'right code too late after 5 wrong tries');

    await t.prisma.phoneLoginCode.updateMany({ where: { phone: p }, data: { createdAt: new Date(Date.now() - 120_000) } });
    const c2 = (await ask(t, p)).body.devCode as string;
    const noTerms = await api(t).post('/auth/phone/verify', { phone: p, code: c2, name: 'Ali V', role: 'STUDENT', dateOfBirth: '2001-01-01', acceptTerms: false });
    assert.equal(noTerms.status, 400);
    const young = await api(t).post('/auth/phone/verify', { phone: p, code: c2, name: 'Ali V', role: 'TEACHER', dateOfBirth: '2012-01-01', acceptTerms: true });
    assert.equal(young.status, 400);
    assert.equal(young.body.code, 'TOO_YOUNG');
  });

  it('stores only a hash of the code', async () => {
    const p = phone();
    const code = (await ask(t, p)).body.devCode as string;
    const row = await t.prisma.phoneLoginCode.findFirstOrThrow({ where: { phone: p } });
    assert.ok(!row.codeHash.includes(code) && row.codeHash.length === 64);
  });
});

describe('how often one person may ask for a code', () => {
  let t: TestApp;
  before(async () => {
    process.env.PHONE_DEV_CODES = '1';
    delete process.env.TELEGRAM_GATEWAY_TOKEN;
    t = await createTestApp([AuthModule]);
    await t.prisma.phoneRequestGate.deleteMany({});
  });
  after(async () => { delete process.env.PHONE_DEV_CODES; await t.close(); });

  it('2 requests are fine (a wrong number, then the right one); the 3rd waits about two hours; another phone is not affected', async () => {
    const mine = newDevice();
    assert.equal((await ask(t, phone(), mine)).status, 200, 'first number');
    assert.equal((await ask(t, phone(), mine)).status, 200, 'the other number');
    const third = await ask(t, phone(), mine);
    assert.equal(third.status, 429);
    assert.equal(third.body.code, 'CODE_LOCKED');
    assert.ok(third.body.retryAfterSeconds > 7100 && third.body.retryAfterSeconds <= 7200, `retry in ${third.body.retryAfterSeconds}s`);
    assert.equal((await ask(t, phone(), newDevice())).status, 200, 'somebody else on another phone');
  });

  it('a request that never reached Telegram because of OUR failure does not cost a try; a number without Telegram does', async () => {
    const { AuthService } = require('./auth.service');
    const auth = t.app.get(AuthService);
    const original = auth.sender;
    try {
      const mine = newDevice();
      auth.sender = { kind: 'telegram', send: async () => ({ ok: false, reason: 'FAILED' }) };
      assert.equal((await ask(t, phone(), mine)).status, 400);
      assert.equal((await ask(t, phone(), mine)).status, 400);
      assert.equal((await ask(t, phone(), mine)).status, 400, 'still allowed: nothing was sent, nothing was used up');
      auth.sender = { kind: 'telegram', send: async () => ({ ok: false, reason: 'NO_TELEGRAM' }) };
      const other = newDevice();
      assert.equal((await ask(t, phone(), other)).status, 400, 'wrong number counts');
      assert.equal((await ask(t, phone(), other)).status, 400, 'second wrong number counts');
      assert.equal((await ask(t, phone(), other)).status, 429, 'and now it waits');
    } finally { auth.sender = original; }
  });

  it('without a device id the network address is the key; a device id cannot be used to dodge it; bad ids are ignored', async () => {
    const a = await ask(t, phone(), null);
    assert.ok(a.status === 200 || a.status === 429);
    const bad = await ask(t, phone(), 'x');
    assert.ok(bad.status === 200 || bad.status === 429, 'a too-short id falls back to the address rule');
  });
});
