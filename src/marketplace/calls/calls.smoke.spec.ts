// Headless ikki-brauzer smoke testi: HAQIQIY WebRTC (peer-to-peer, soxta kamera/mikrofon) + MOCK signalizatsiya.
// Bu SFU/TURN'ni, haqiqiy tarmoqni va telefonlarni sinamaydi (KNOWN_GAPS.md). Brauzer topilmasa test o'tkazib yuboriladi.
import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { ClockService } from '../common/clock';
import { api, createTestApp, makeAdmin, makeTeacher, makeUser, TestApp } from '../testing/harness';
import { SmokeModule } from '../testing/smoke';

const CANDIDATES = [
  process.env.SMOKE_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean) as string[];
const browserPath = CANDIDATES.find((p) => existsSync(p));

const at = (hms: string) => new Date('2026-11-03T' + hms + 'Z');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('two-browser video call smoke test (real WebRTC, mock signaling)', { skip: browserPath ? false : 'no Chromium-based browser found' }, () => {
  let t: TestApp;
  let browser: any;
  let clock: ClockService;

  before(async () => {
    t = await createTestApp([SmokeModule]);
    clock = t.app.get(ClockService);
    const puppeteer = require('puppeteer-core');
    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: true,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--no-first-run', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
    });
  });
  after(async () => {
    clock.set(null);
    await browser?.close();
    await t.close();
  });

  async function openPage(bookingId: string, auth: string) {
    const page = await browser.newPage();
    page.on('pageerror', (e: Error) => console.error('PAGE ERROR', e.message));
    await page.goto(`${t.baseUrl}/__smoke/page#booking=${bookingId}&auth=${auth}`);
    return page;
  }
  const waitState = async (page: any, state: string, ms = 20_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = await page.evaluate(() => (window as any).__state());
      if (s.state === state) return s;
      await sleep(150);
    }
    throw new Error('timeout waiting for ' + state + ': ' + JSON.stringify(await page.evaluate(() => (window as any).__state())).slice(0, 1800));
  };

  it('teacher and pupil connect with real media, survive a drop + reconnect, finish with accurate billing', async () => {
    const admin = await makeAdmin(t);
    const tch = await makeTeacher(t, { approve: { adminToken: admin.token } });
    await api(t, tch.user.token).put('/teachers/me/profile', { instantBooking: true });
    const student = await makeUser(t);
    clock.set(new Date('2026-11-02T00:00:00Z'));
    const b = (await api(t, student.token).post('/bookings', { teacherId: tch.profileId, startAt: '2026-11-03T05:00:00.000Z', durationMin: 60 })).body;
    assert.equal(b.status, 'CONFIRMED');

    clock.set(at('04:58:00'));
    const p1 = await openPage(b.id, tch.user.token);
    const p2 = await openPage(b.id, student.token);
    await p1.evaluate(() => (window as any).__start());
    await p2.evaluate(() => (window as any).__start());
    let s1: any, s2: any;
    try {
      s1 = await waitState(p1, 'connected');
      s2 = await waitState(p2, 'connected');
    } catch (e) {
      const dump = async (p: any) => JSON.stringify(await p.evaluate(() => (window as any).__state())).slice(0, 1500);
      throw new Error('smoke connect failed | P1 ' + (await dump(p1)) + ' | P2 ' + (await dump(p2)));
    }
    assert.ok(s1.remoteW > 0 && s2.remoteW > 0, 'both sides render remote video');
    console.log(`    smoke: join times ms teacher=${s1.joinMs} pupil=${s2.joinMs} (local loopback, NOT a network measurement)`);

    try {
      // Tarmoq uzilishi: p2 ulanishni tashlaydi va avtomatik qayta ulanadi
      await p2.evaluate(() => (window as any).__drop());
      assert.equal((await p2.evaluate(() => (window as any).__state())).banner, 'reconnecting');
      const back = await waitState(p2, 'connected', 25_000);
      assert.equal(back.reconnects, 1);
      assert.ok(back.remoteW > 0);

      // Dars vaqti o'tadi: heartbeat'lar bilan 06:00 gacha, so'ng ikkalasi chiqadi
      clock.set(at('05:30:00'));
      await p1.evaluate(() => (window as any).__heartbeat());
      await p2.evaluate(() => (window as any).__heartbeat());
      clock.set(at('06:00:00'));
      await p1.evaluate(() => (window as any).__heartbeat());
      await p2.evaluate(() => (window as any).__heartbeat());
      await p1.evaluate(() => (window as any).__leave());
      await p2.evaluate(() => (window as any).__leave());
      await sleep(800);

      const sum = (await api(t, student.token).get('/calls/' + b.id + '/summary')).body;
      assert.equal(sum.status, 'COMPLETED');
      assert.equal(sum.billableSeconds, 3600, 'billable is capped at the scheduled hour');
      const events = await t.prisma.callEvent.findMany({ where: { bookingId: b.id } });
      assert.ok(events.some((e) => e.type === 'rejoined'), 'reconnect was recorded');
      assert.ok(events.some((e) => e.type === 'quality'));
    } catch (e) {
      // Vaqti-vaqti bilan (to'liq to'plamda) uchraydigan nosozlik uchun tashxis: sahifalar holati va server voqealari
      const dump = async (pg: any) => JSON.stringify(await pg.evaluate(() => (window as any).__state()).catch(() => 'n/a')).slice(0, 1500);
      const ev = await t.prisma.callEvent.findMany({ where: { bookingId: b.id }, orderBy: { at: 'asc' } });
      console.error('SMOKE DIAGNOSTICS P1', await dump(p1), 'P2', await dump(p2), 'EVENTS', ev.map((x) => x.type).join(','));
      throw e;
    }
    // Boshqa foydalanuvchi signalizatsiyaga ham, tokenga ham ega emas
    const outsider = await makeUser(t);
    clock.set(at('04:58:00'));
    assert.equal((await api(t, outsider.token).post('/calls/' + b.id + '/token')).status, 404);
    assert.equal((await fetch(`${t.baseUrl}/__smoke/signal?token=forged`)).status, 403);
    await p1.close();
    await p2.close();
  });
});
