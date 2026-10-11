import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Role } from '@prisma/client';
import { ClockService } from '../common/clock';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makeTeacher, makeUser, TestApp } from '../testing/harness';
import { ExpoPushSender, LogPushSender, NotificationDispatcher, PUSH_SENDER } from './dispatcher.service';
import { NotificationsService } from './notifications.service';
import { render, TEMPLATES } from './templates';

const NOW = new Date('2026-11-02T00:00:00Z');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : [];
  });
}

describe('notification templates (pure)', () => {
  it('every notification type used anywhere in the code has uz/ru/en title and body', () => {
    const root = join(__dirname, '..');
    const used = new Set<string>();
    for (const f of walk(root)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/notifications\.enqueue\(\s*[^,]+,\s*'([a-z_.]+)'/g)) used.add(m[1]);
    }
    assert.ok(used.size >= 15, `found ${used.size} types`);
    for (const type of used) {
      for (const loc of ['uz', 'ru', 'en'] as const) {
        const tpl = TEMPLATES[type]?.[loc];
        assert.ok(tpl && tpl.title.length > 2 && tpl.body.length > 5, `${type}/${loc}`);
      }
    }
    for (const type of Object.keys(TEMPLATES)) assert.ok(used.has(type), `unused template ${type}`);
  });
  it('push text never contains message content, names or amounts (templates are generic)', () => {
    for (const [type, byLoc] of Object.entries(TEMPLATES)) for (const t of Object.values(byLoc)) {
      assert.ok(!/\{|\}|\d{3,}/.test(t.title + t.body), type);
    }
  });
  it('unknown locale falls back to uz; unknown type does not crash', () => {
    assert.equal(render('message.new', 'de').title, TEMPLATES['message.new'].uz.title);
    assert.equal(render('nope', 'en').title, 'School17');
  });
});

describe('Expo push sender (fake fetch)', () => {
  it('batches, maps tickets and reports DeviceNotRegistered', async () => {
    const calls: any[] = [];
    const fake: any = async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      return { ok: true, json: async () => ({ data: body.map((_m: any, i: number) => (i === 1 ? { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' })) }) };
    };
    const s = new ExpoPushSender(fake);
    const r = await s.send([{ to: 'a', title: 't', body: 'b' }, { to: 'b', title: 't', body: 'b' }, { to: 'c', title: 't', body: 'b' }]);
    assert.deepEqual(r.map((x) => [x.token, x.ok, x.error]), [['a', true, undefined], ['b', false, 'DeviceNotRegistered'], ['c', true, undefined]]);
    assert.equal(calls.length, 1);
    const down: any = async () => ({ ok: false, status: 503 });
    assert.equal((await new ExpoPushSender(down).send([{ to: 'a', title: 't', body: 'b' }]))[0].ok, false);
  });
});

describe('notifications (integration)', () => {
  let t: TestApp;
  let clock: ClockService;
  let dispatcher: NotificationDispatcher;
  let notifications: NotificationsService;
  let sender: LogPushSender;

  before(async () => {
    t = await createTestApp();
    clock = t.app.get(ClockService);
    clock.set(NOW);
    dispatcher = t.app.get(NotificationDispatcher);
    notifications = t.app.get(NotificationsService);
    sender = t.app.get(PUSH_SENDER);
  });
  after(async () => {
    clock.set(null);
    await t.close();
  });

  const RUN = Math.random().toString(36).slice(2, 8); // testlar qayta ishlaganda token to'qnashmasligi uchun
  const tok = (n: string) => `ExponentPushToken[${n}-${RUN}-xxxxxx]`;

  it('route matrix', async () => {
    const admin = await makeAdmin(t);
    const actors = { STUDENT: await makeUser(t, Role.STUDENT), GUARDIAN: await makeUser(t, Role.GUARDIAN), TEACHER: await makeUser(t, Role.TEACHER), adminToken: admin.token };
    const failures = await checkRouteMatrix(t, actors, [
      { method: 'GET', path: '/notifications', allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'GET', path: '/notifications/unread-count', allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'POST', path: '/notifications/read-all', allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'POST', path: '/push-tokens', body: { token: tok('abc'), platform: 'android' }, allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('inbox is rendered in the user\'s language, shows only due items, supports read/read-all, and is private', async () => {
    const ru = await makeUser(t, Role.STUDENT, { locale: 'ru' });
    const other = await makeUser(t);
    await notifications.enqueue(ru.id, 'message.new', { threadId: 'x' });
    await notifications.enqueue(ru.id, 'booking.reminder', { bookingId: 'b' }, { dueAt: new Date(NOW.getTime() + 3_600_000) });
    await notifications.enqueue(other.id, 'message.new', {});
    const list = (await api(t, ru.token).get('/notifications')).body;
    assert.equal(list.length, 1, 'future reminder is not visible yet');
    assert.equal(list[0].title, 'Новое сообщение');
    assert.equal(list[0].read, false);
    assert.equal((await api(t, ru.token).get('/notifications/unread-count')).body.unread, 1);
    assert.equal((await api(t, other.token).post(`/notifications/${list[0].id}/read`)).body.updated, 0, 'cannot mark someone else\'s');
    assert.equal((await api(t, ru.token).get('/notifications?unread=true')).body.length, 1);
    await api(t, ru.token).post(`/notifications/${list[0].id}/read`);
    assert.equal((await api(t, ru.token).get('/notifications/unread-count')).body.unread, 0);
    clock.set(new Date(NOW.getTime() + 2 * 3_600_000));
    const later = (await api(t, ru.token).get('/notifications')).body;
    assert.equal(later.length, 2);
    assert.equal((await api(t, ru.token).post('/notifications/read-all')).body.updated, 1);
    clock.set(NOW);
  });

  it('push tokens: validated format, one owner per token, removable only by the owner', async () => {
    const a = await makeUser(t);
    const b = await makeUser(t);
    assert.equal((await api(t, a.token).post('/push-tokens', { token: 'not-a-token', platform: 'android' })).status, 400);
    assert.equal((await api(t, a.token).post('/push-tokens', { token: tok('shared'), platform: 'web' })).status, 400);
    assert.equal((await api(t, a.token).post('/push-tokens', { token: tok('shared'), platform: 'android' })).status, 200);
    assert.equal((await api(t, b.token).post('/push-tokens', { token: tok('shared'), platform: 'ios' })).status, 200);
    assert.equal((await t.prisma.pushToken.findUniqueOrThrow({ where: { token: tok('shared') } })).userId, b.id, 'token moves to the new signed-in user');
    assert.equal((await api(t, a.token).del('/push-tokens')).status, 400);
    await fetch(t.baseUrl + '/push-tokens', { method: 'DELETE', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + a.token }, body: JSON.stringify({ token: tok('shared') }) });
    assert.equal(await t.prisma.pushToken.count({ where: { token: tok('shared') } }), 1, 'a cannot delete b\'s token');
  });

  it('dispatcher: pushes in the user\'s language to every device, marks sent, in-app only without tokens, drops dead tokens, retries failures', async () => {
    const u = await makeUser(t, Role.STUDENT, { locale: 'en' });
    const none = await makeUser(t);
    await t.prisma.pushToken.createMany({ data: [{ userId: u.id, token: tok('dev1'), platform: 'android' }, { userId: u.id, token: tok('dev2'), platform: 'ios' }] });
    const n1 = await notifications.enqueue(u.id, 'payment.refunded', { bookingId: 'b', amountMinor: 12345 });
    const n2 = await notifications.enqueue(none.id, 'message.new', {});
    const before = sender.sent.length;
    const r = await dispatcher.deliverDue(100, [u.id, none.id]);
    assert.ok(r.sent >= 2);
    const mine = sender.sent.slice(before).filter((m) => [tok('dev1'), tok('dev2')].includes(m.to));
    assert.equal(mine.length, 2);
    assert.equal(mine[0].title, 'Refund issued');
    assert.ok(!JSON.stringify(mine).includes('12345'), 'amount never in push text or data');
    assert.ok(!JSON.stringify(mine[0].data).includes('amountMinor'));
    assert.ok((await t.prisma.notification.findUniqueOrThrow({ where: { id: n1!.id } })).sentAt);
    assert.ok((await t.prisma.notification.findUniqueOrThrow({ where: { id: n2!.id } })).sentAt, 'no tokens => marked delivered to the in-app inbox');
    assert.equal((await dispatcher.deliverDue(100, [u.id, none.id])).sent, 0, 'nothing is sent twice');

    // sentAt yo'q, kelajakdagi bildirishnoma hozir yuborilmaydi
    await notifications.enqueue(u.id, 'booking.reminder', {}, { dueAt: new Date(NOW.getTime() + 3_600_000) });
    const b2 = sender.sent.length;
    await dispatcher.deliverDue(100, [u.id]);
    assert.equal(sender.sent.length, b2);

    // xatolik: qayta uriniladi; DeviceNotRegistered tokenni o'chiradi
    const orig = sender.send.bind(sender);
    let mode: 'fail' | 'dead' = 'fail';
    (sender as any).send = async (msgs: any[]) => msgs.map((m) => (mode === 'fail' ? { token: m.to, ok: false, error: 'boom' } : { token: m.to, ok: false, error: 'DeviceNotRegistered' }));
    try {
      const f = await notifications.enqueue(u.id, 'review.new', {});
      const res = await dispatcher.deliverDue(100, [u.id]);
      assert.ok(res.failed >= 1);
      const row = await t.prisma.notification.findUniqueOrThrow({ where: { id: f!.id } });
      assert.equal(row.sentAt, null);
      assert.equal(row.attempts, 1);
      assert.equal(row.lastError, 'boom');
      mode = 'dead';
      await dispatcher.deliverDue(100, [u.id]);
      assert.equal(await t.prisma.pushToken.count({ where: { userId: u.id } }), 0, 'dead tokens removed');
      assert.ok((await t.prisma.notification.findUniqueOrThrow({ where: { id: f!.id } })).sentAt);
    } finally {
      (sender as any).send = orig;
    }
  });

  it('a suspended or deleted user receives no push; real flows enqueue localized items (booking -> teacher)', async () => {
    const admin = await makeAdmin(t);
    const tch = await makeTeacher(t, { approve: { adminToken: admin.token } }); // so'rov rejimi
    const s = await makeUser(t);
    await t.prisma.pushToken.create({ data: { userId: tch.user.id, token: tok('teacher1'), platform: 'android' } });
    await t.prisma.user.update({ where: { id: tch.user.id }, data: { locale: 'uz' } });
    const b = await api(t, s.token).post('/bookings', { teacherId: tch.profileId, startAt: '2026-11-04T06:00:00.000Z', durationMin: 60 });
    assert.equal(b.status, 201);
    const before = sender.sent.length;
    await dispatcher.deliverDue(100, [tch.user.id]);
    const got = sender.sent.slice(before).filter((m) => m.to === tok('teacher1'));
    assert.equal(got[0].title, "Yangi dars so'rovi");
    await t.prisma.user.update({ where: { id: s.id }, data: { status: 'SUSPENDED' } });
    await t.prisma.pushToken.create({ data: { userId: s.id, token: tok('susp'), platform: 'ios' } });
    await notifications.enqueue(s.id, 'message.new', {});
    const b3 = sender.sent.length;
    await dispatcher.deliverDue(100, [s.id]);
    assert.ok(!sender.sent.slice(b3).some((m) => m.to === tok('susp')));
  });
});
