import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { ClockService } from '../common/clock';
import { api, createTestApp, makeUser, TestApp } from '../testing/harness';
import { CATEGORIES, formatHm, parseHm, quietUntil, ruleFor, TYPE_RULES } from './categories';
import { createPushSender, ExpoPushSender, LogPushSender, NotificationDispatcher, PUSH_SENDER } from './dispatcher.service';
import { NotificationsService } from './notifications.service';
import { TEMPLATES } from './templates';

const NOW = new Date('2026-11-02T10:00:00Z'); // Toshkentda 15:00

describe('push categories and quiet hours (pure)', () => {
  it('every notification type has a category rule and urgent ones are only time-critical', () => {
    for (const type of Object.keys(TEMPLATES)) assert.ok(TYPE_RULES[type], `no rule for ${type}`);
    for (const type of Object.keys(TYPE_RULES)) assert.ok(TEMPLATES[type], `rule for unknown type ${type}`);
    for (const r of Object.values(TYPE_RULES)) assert.ok(CATEGORIES.includes(r.category) && r.ttlSeconds >= 600);
    assert.deepEqual(Object.entries(TYPE_RULES).filter(([, r]) => r.priority === 'urgent').map(([k]) => k).sort(), ['booking.cancelled', 'booking.reminder', 'class.cancelled', 'class.live', 'class.reminder_soon', 'class.session_cancelled', 'guardian.linked']);
    assert.equal(ruleFor('totally.unknown').category, 'account', 'unknown types fall back to the non-disableable category');
    assert.equal(ruleFor('class.live').ttlSeconds, 600, 'a "class is live" push expires after 10 minutes');
  });
  it('quiet hours: same-day and midnight-wrapping windows in the user time zone', () => {
    const tz = 'Asia/Tashkent'; // UTC+5
    const at = (iso: string) => new Date(iso);
    // 22:00-07:00 qoida; 23:30 Toshkent = 18:30 UTC
    assert.equal(quietUntil(at('2026-11-02T18:30:00Z'), tz, 22 * 60, 7 * 60)?.toISOString(), '2026-11-03T02:00:00.000Z', 'ends at 07:00 next morning');
    assert.equal(quietUntil(at('2026-11-02T22:00:00Z'), tz, 22 * 60, 7 * 60)?.toISOString(), '2026-11-03T02:00:00.000Z', '03:00 local, same morning');
    assert.equal(quietUntil(at('2026-11-02T10:00:00Z'), tz, 22 * 60, 7 * 60), null, 'afternoon is not quiet');
    assert.equal(quietUntil(at('2026-11-02T02:00:00Z'), tz, 7 * 60, 7 * 60), null, 'equal start/end disables');
    assert.equal(quietUntil(at('2026-11-02T10:00:00Z'), tz, null, null), null);
    assert.equal(quietUntil(at('2026-11-02T08:30:00Z'), tz, 13 * 60, 14 * 60)?.toISOString(), '2026-11-02T09:00:00.000Z', 'same-day window 13:00-14:00');
    assert.equal(parseHm('07:05'), 425);
    assert.equal(parseHm('24:00'), null);
    assert.equal(parseHm('7:5'), null);
    assert.equal(formatHm(425), '07:05');
  });
  it('the real Expo sender is only used when EXPO_PUSH_ENABLED=true; payload carries channel, ttl, priority; invalid tokens are reported', async () => {
    assert.ok(createPushSender({ PUSH_PROVIDER: 'expo' } as any) instanceof LogPushSender, 'provider alone is not enough');
    assert.ok(createPushSender({ PUSH_PROVIDER: 'expo', EXPO_PUSH_ENABLED: 'true' } as any) instanceof ExpoPushSender);
    assert.ok(createPushSender({ EXPO_PUSH_ENABLED: 'true' } as any) instanceof LogPushSender);
    let body: any;
    let headers: any;
    const fake = (async (_u: string, init: any) => {
      body = JSON.parse(init.body);
      headers = init.headers;
      return { ok: true, json: async () => ({ data: [{ status: 'ok' }, { status: 'error', details: { error: 'DeviceNotRegistered' } }] }) };
    }) as any;
    const res = await new ExpoPushSender(fake, 'http://x', 'secret-token').send([
      { to: 'ExponentPushToken[aaaaaaaaaaaa]', title: 'T', body: 'B', channelId: 'classes', ttl: 600, priority: 'high', interruptionLevel: 'time-sensitive' },
      { to: 'ExponentPushToken[bbbbbbbbbbbb]', title: 'T', body: 'B' },
    ]);
    assert.equal(body[0].channelId, 'classes');
    assert.equal(body[0].ttl, 600);
    assert.equal(body[0].interruptionLevel, 'time-sensitive');
    assert.equal(headers.authorization, 'Bearer secret-token');
    assert.deepEqual(res.map((r) => [r.ok, r.error]), [[true, undefined], [false, 'DeviceNotRegistered']]);
  });
});

describe('push preferences and delivery rules (integration)', () => {
  let t: TestApp;
  let clock: ClockService;
  let dispatcher: NotificationDispatcher;
  let notifications: NotificationsService;
  let sender: LogPushSender;
  let n = 0;
  const run = Math.random().toString(36).slice(2, 8);
  const tok = () => `ExponentPushToken[tok${run}${String(++n).padStart(4, '0')}]`;

  before(async () => {
    t = await createTestApp([], { throttle: true });
    clock = t.app.get(ClockService);
    clock.set(NOW);
    dispatcher = t.app.get(NotificationDispatcher);
    notifications = t.app.get(NotificationsService);
    sender = t.app.get(PUSH_SENDER) as LogPushSender;
  });
  after(async () => {
    clock.set(null);
    await t.close();
  });

  async function pupil(tz = 'Asia/Tashkent') {
    const u = await makeUser(t, Role.STUDENT, { timezone: tz, locale: 'en' });
    const token = tok();
    await t.prisma.pushToken.create({ data: { userId: u.id, token, platform: 'android' } });
    return { u, token };
  }
  const pushedTo = (token: string) => sender.sent.filter((m) => m.to === token);

  it('preferences API: defaults, validation, own data only, account category cannot be disabled', async () => {
    const { u } = await pupil();
    const other = await makeUser(t);
    const d = (await api(t, u.token).get('/notifications/preferences')).body;
    assert.deepEqual(d.categories.map((c: any) => c.id), [...CATEGORIES]);
    assert.ok(d.categories.every((c: any) => c.enabled));
    assert.equal(d.categories.find((c: any) => c.id === 'account').canDisable, false);
    assert.equal(d.quiet, null);
    const put = await api(t, u.token).put('/notifications/preferences', { disabled: ['messages', 'account', 'messages'], quietStart: '22:00', quietEnd: '07:00' });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.categories.find((c: any) => c.id === 'messages').enabled, false);
    assert.equal(put.body.categories.find((c: any) => c.id === 'account').enabled, true, 'account is silently kept on');
    assert.deepEqual(put.body.quiet, { start: '22:00', end: '07:00' });
    assert.equal((await api(t, other.token).get('/notifications/preferences')).body.quiet, null, 'user B sees none of user A settings');
    for (const bad of [{ disabled: ['nope'] }, { quietStart: '25:00', quietEnd: '07:00' }, { quietStart: '22:00' }, { quietStart: '22:00', quietEnd: '22:00' }, { disabled: 'messages' }, { quietStart: 'x', quietEnd: 'y' }]) {
      assert.equal((await api(t, u.token).put('/notifications/preferences', bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await api(t, u.token).put('/notifications/preferences', { quietStart: null, quietEnd: null, disabled: [] })).body.quiet, null, 'quiet hours can be cleared');
    assert.equal((await api(t).get('/notifications/preferences')).status, 401);
  });

  it('a disabled category sends no push but the inbox still has the item; other categories still push', async () => {
    const { u, token } = await pupil();
    await api(t, u.token).put('/notifications/preferences', { disabled: ['messages'] });
    const m = await notifications.enqueue(u.id, 'message.new', { threadId: 't1' });
    const l = await notifications.enqueue(u.id, 'booking.confirmed', { bookingId: 'b1' });
    await dispatcher.deliverDue(100, [u.id]);
    assert.deepEqual(pushedTo(token).map((p) => p.data?.type), ['booking.confirmed']);
    assert.ok((await t.prisma.notification.findUniqueOrThrow({ where: { id: m!.id } })).sentAt, 'handled');
    const inbox = (await api(t, u.token).get('/notifications')).body.map((x: any) => x.type).sort();
    assert.deepEqual(inbox, ['booking.confirmed', 'message.new'], 'the muted item stays visible in the app');
    assert.ok(l);
  });

  it('quiet hours delay normal pushes until the window ends (inbox is immediate); urgent ones go through', async () => {
    const { u, token } = await pupil();
    await api(t, u.token).put('/notifications/preferences', { quietStart: '14:00', quietEnd: '18:00' }); // 15:00 local is inside
    const normal = await notifications.enqueue(u.id, 'message.new', { threadId: 't2' });
    const urgent = await notifications.enqueue(u.id, 'class.live', { classId: 'c', sessionId: 's' });
    await dispatcher.deliverDue(100, [u.id]);
    assert.deepEqual(pushedTo(token).map((p) => p.data?.type), ['class.live'], 'urgent bypasses quiet hours');
    const row = await t.prisma.notification.findUniqueOrThrow({ where: { id: normal!.id } });
    assert.equal(row.sentAt, null);
    assert.equal(row.pushAfter?.toISOString(), '2026-11-02T13:00:00.000Z', '18:00 Tashkent');
    assert.equal((await api(t, u.token).get('/notifications')).body.length, 2, 'inbox shows both right away');
    clock.set(new Date('2026-11-02T12:59:00Z'));
    await dispatcher.deliverDue(100, [u.id]);
    assert.equal(pushedTo(token).length, 1, 'still waiting');
    clock.set(new Date('2026-11-02T13:01:00Z'));
    await dispatcher.deliverDue(100, [u.id]);
    assert.deepEqual(pushedTo(token).map((p) => p.data?.type), ['class.live', 'message.new']);
    assert.ok(urgent);
    clock.set(NOW);
  });

  it('push payload: generic text, ids only, channel = category, urgent = high priority + time-sensitive, short ttl', async () => {
    const { u, token } = await pupil();
    await notifications.enqueue(u.id, 'class.live', { classId: 'cc', sessionId: 'ss', secret: 'x', amountMinor: 1 });
    await notifications.enqueue(u.id, 'review.new', { reviewId: 'rr' });
    await dispatcher.deliverDue(100, [u.id]);
    const [live, review] = pushedTo(token);
    assert.equal(live.channelId, 'classes');
    assert.equal(live.ttl, 600);
    assert.equal(live.priority, 'high');
    assert.equal(live.interruptionLevel, 'time-sensitive');
    assert.deepEqual(live.data, { type: 'class.live', classId: 'cc', sessionId: 'ss' });
    assert.equal(review.priority, 'normal');
    assert.equal(review.interruptionLevel, 'passive');
  });

  it('message pushes are coalesced per thread in 5 minute windows', async () => {
    const { u, token } = await pupil();
    for (let i = 0; i < 4; i++) await notifications.enqueue(u.id, 'message.new', { threadId: 'thr' }, { dedupeKey: `msg:thr:${Math.floor(clock.now().getTime() / 300_000)}` });
    await dispatcher.deliverDue(100, [u.id]);
    assert.equal(pushedTo(token).length, 1, 'four messages in one window = one push');
  });

  it('device tokens: validated, one owner, at most 10 per user (oldest dropped), removable only by the owner; registration is rate limited', async () => {
    const run2 = Math.random().toString(36).slice(2, 8);
    const a = await makeUser(t);
    const b = await makeUser(t);
    for (let i = 0; i < 12; i++) {
      assert.equal((await api(t, a.token).post('/push-tokens', { token: `ExponentPushToken[cap${run2}${String(i).padStart(3, '0')}x]`, platform: 'android' })).status, 200, 'registration ' + i);
      await t.prisma.pushToken.updateMany({ where: { token: `ExponentPushToken[cap${run2}${String(i).padStart(3, '0')}x]` }, data: { lastSeenAt: new Date(NOW.getTime() + i * 1000) } });
    }
    assert.equal(await t.prisma.pushToken.count({ where: { userId: a.id } }), 10);
    assert.equal((await api(t, a.token).post('/push-tokens', { token: 'not-a-token', platform: 'android' })).status, 400);
    assert.equal((await api(t, a.token).post('/push-tokens', { token: 'ExponentPushToken[abcdefghijkl]', platform: 'windows' })).status, 400);
    const mine = (await t.prisma.pushToken.findFirstOrThrow({ where: { userId: a.id } })).token;
    assert.equal((await api(t, b.token).del('/push-tokens')).status >= 400, true);
    await fetch(t.baseUrl + '/push-tokens', { method: 'DELETE', headers: { authorization: 'Bearer ' + b.token, 'content-type': 'application/json' }, body: JSON.stringify({ token: mine }) });
    assert.equal(await t.prisma.pushToken.count({ where: { token: mine } }), 1, 'another user cannot remove my token');
    const codes: number[] = [];
    for (let i = 0; i < 25; i++) codes.push((await api(t, b.token).post('/push-tokens', { token: `ExponentPushToken[rate${run2}${String(i).padStart(3, '0')}]`, platform: 'ios' })).status);
    assert.ok(codes.includes(429), 'abuse limit: ' + codes.join(','));
  });
});

describe('push test endpoint', () => {
  it('sends a test notification to the caller only and is limited to 3 per hour', async () => {
    const t = await createTestApp([], { throttle: true });
    try {
      const u = await makeUser(t);
      const other = await makeUser(t);
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await api(t, u.token).post('/notifications/test')).status);
      assert.deepEqual(codes, [200, 200, 200, 429, 429]);
      assert.equal(await t.prisma.notification.count({ where: { userId: u.id, type: 'push.test' } }), 3);
      assert.equal(await t.prisma.notification.count({ where: { userId: other.id } }), 0, 'nothing leaks to other users');
      assert.equal((await api(t).post('/notifications/test')).status, 401);
    } finally {
      await t.close();
    }
  });
});
