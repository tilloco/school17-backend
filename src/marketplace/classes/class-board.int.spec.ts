import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { ClockService } from '../common/clock';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makeTeacher, makeUser, TestApp, TestUser } from '../testing/harness';
import { BOARD_LIMITS, renderBoardPng } from './class-board.service';

const START = '2026-11-05T10:00:00.000Z';
const at = (m: number) => new Date(new Date(START).getTime() + m * 60_000);
const stroke = (n = 3, c = '#1155cc') => ({ c, w: 3, p: Array.from({ length: n }, (_, i) => [0.1 + i * 0.05, 0.2 + i * 0.03]) });

describe('class whiteboard and feed (R6, integration)', () => {
  let t: TestApp;
  let clock: ClockService;
  let admin: { id: string; token: string };

  async function klass(n = 2, startLive = true) {
    clock.set(new Date('2026-11-02T00:00:00Z'));
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const c = (await api(t, x.user.token).post('/classes', { title: 'Math', subject: 'Math', capacity: 30, oneOffStartAt: START })).body;
    const ps: TestUser[] = [];
    for (let i = 0; i < n; i++) {
      const u = await makeUser(t, Role.STUDENT);
      await api(t, u.token).post('/classes/join', { code: c.joinCode });
      ps.push(u);
    }
    const sid = (await api(t, x.user.token).get(`/classes/${c.id}/sessions`)).body[0].id as string;
    if (startLive) {
      clock.set(at(-5));
      await api(t, x.user.token).post(`/class-sessions/${sid}/start`);
    }
    return { x, c, ps, sid, base: `/class-sessions/${sid}/whiteboard` };
  }

  before(async () => {
    t = await createTestApp();
    clock = t.app.get(ClockService);
    admin = await makeAdmin(t);
  });
  after(async () => {
    clock.set(null);
    await t.close();
  });

  it('route matrix', async () => {
    const actors = { STUDENT: await makeUser(t, Role.STUDENT), GUARDIAN: await makeUser(t, Role.GUARDIAN), TEACHER: (await makeTeacher(t, { approve: { adminToken: admin.token } })).user, adminToken: admin.token };
    const id = '11111111-1111-4111-8111-111111111111';
    const failures = await checkRouteMatrix(t, actors, [
      { method: 'GET', path: `/class-sessions/${id}/whiteboard`, allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'PUT', path: `/class-sessions/${id}/whiteboard`, body: { strokes: [] }, allowed: ['TEACHER'] },
      { method: 'POST', path: `/class-sessions/${id}/whiteboard/save`, body: {}, allowed: ['TEACHER'] },
      { method: 'GET', path: `/classes/${id}/feed`, allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'GET', path: `/classes/${id}/feed/${id}/image`, allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('snapshot flow: teacher writes, pupils and late joiners read the latest, rev follows, pupils cannot write', async () => {
    const { x, c, ps, sid, base } = await klass(2);
    assert.deepEqual((await api(t, ps[0].token).get(base)).body, { rev: 0, strokes: [], updatedAt: null });
    const put1 = await api(t, x.user.token).put(base, { strokes: [stroke(3)] });
    assert.equal(put1.status, 200, JSON.stringify(put1.body));
    assert.equal(put1.body.rev, 1);
    assert.equal((await api(t, x.user.token).put(base, { strokes: [stroke(3), stroke(4, '#ff0000')] })).body.rev, 2);
    const late = await makeUser(t);
    await api(t, late.token).post('/classes/join', { code: c.joinCode });
    const snap = (await api(t, late.token).get(base)).body;
    assert.equal(snap.rev, 2);
    assert.equal(snap.strokes.length, 2, 'a late joiner gets the latest snapshot');
    assert.equal((await api(t, ps[1].token).get(`/class-sessions/${sid}`)).body.whiteboardRev, 2, 'session state carries the revision for polling');
    assert.equal((await api(t, ps[0].token).put(base, { strokes: [stroke()] })).status, 403, 'pupils cannot draw');
    assert.equal((await api(t, (await makeUser(t)).token).get(base)).status, 404);
    const other = await makeTeacher(t, { approve: { adminToken: admin.token } });
    assert.equal((await api(t, other.user.token).put(base, { strokes: [stroke()] })).status, 404);
    assert.equal((await api(t, other.user.token).get(base)).status, 404);
  });

  it('input is validated and bounded; writes need an open class and are rate limited', async () => {
    const { x, base, sid } = await klass(1);
    for (const bad of [[{ c: 'red', w: 3, p: [[0, 0]] }], [{ c: '#000000', w: 3, p: [[1.5, 0]] }], [{ c: '#000000', w: 99, p: [[0, 0]] }], Array.from({ length: BOARD_LIMITS.strokes + 1 }, () => stroke(1)), [stroke(BOARD_LIMITS.perStroke + 1)], Array.from({ length: 6 }, () => stroke(900))]) {
      assert.ok([400, 413].includes((await api(t, x.user.token).put(base, { strokes: bad })).status), 'refused (validation or body size)');
    }
    assert.ok([400, 413].includes((await api(t, x.user.token).put(base, { strokes: [stroke(4999)].concat([stroke(1)]) })).status), 'total points cap');
    assert.equal((await api(t, x.user.token).put(base, { strokes: 'x' as any })).status, 400);
    await api(t, x.user.token).post(`/class-sessions/${sid}/end`);
    assert.equal((await api(t, x.user.token).put(base, { strokes: [stroke()] })).body.code, 'NOT_OPEN');
    // tezlik chegarasi
    const th = await createTestApp([], { throttle: true });
    try {
      const c2 = th.app.get(ClockService);
      c2.set(new Date('2026-11-02T00:00:00Z'));
      const a2 = await makeAdmin(th);
      const x2 = await makeTeacher(th, { approve: { adminToken: a2.token } });
      const cl = (await api(th, x2.user.token).post('/classes', { title: 'Math', subject: 'Math', capacity: 5, oneOffStartAt: START })).body;
      const sid2 = (await api(th, x2.user.token).get(`/classes/${cl.id}/sessions`)).body[0].id;
      c2.set(at(-5));
      await api(th, x2.user.token).post(`/class-sessions/${sid2}/start`);
      const codes: number[] = [];
      for (let i = 0; i < 45; i++) codes.push((await api(th, x2.user.token).put(`/class-sessions/${sid2}/whiteboard`, { strokes: [stroke()] })).status);
      assert.ok(codes.includes(429), codes.join(','));
      c2.set(null);
    } finally {
      await th.close();
    }
  });

  it('save: the server draws a real PNG into the class feed; members see it, strangers do not; empty boards are refused', async () => {
    const { x, c, ps, base } = await klass(2);
    assert.equal((await api(t, x.user.token).post(`${base}/save`, {})).body.code, 'BOARD_EMPTY');
    await api(t, x.user.token).put(base, { strokes: [stroke(5, '#ff0000'), stroke(5, '#00aa00')] });
    assert.equal((await api(t, ps[0].token).post(`${base}/save`, {})).status, 403);
    const saved = await api(t, x.user.token).post(`${base}/save`, { clear: true });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.ok(saved.body.bytes > 500 && saved.body.bytes < 3 * 1024 * 1024);
    assert.equal((await api(t, ps[0].token).get(base)).body.strokes.length, 0, 'cleared after saving');
    const feed = (await api(t, ps[1].token).get(`/classes/${c.id}/feed`)).body;
    assert.equal(feed.length, 1);
    assert.equal(feed[0].kind, 'WHITEBOARD');
    assert.equal(feed[0].hasImage, true);
    const img = await fetch(`${t.baseUrl}/classes/${c.id}/feed/${feed[0].id}/image`, { headers: { authorization: 'Bearer ' + ps[1].token } });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await img.arrayBuffer());
    assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG');
    const sharp = require('sharp');
    const meta = await sharp(buf).metadata();
    assert.deepEqual([meta.width, meta.height], [1280, 720]);
    const raw = await sharp(buf).raw().toBuffer();
    let colored = 0;
    for (let i = 0; i < raw.length; i += 3) if (raw[i] !== 255 || raw[i + 1] !== 255 || raw[i + 2] !== 255) colored++;
    assert.ok(colored > 100, 'strokes were actually drawn');
    const outsider = await makeUser(t);
    assert.equal((await api(t, outsider.token).get(`/classes/${c.id}/feed`)).status, 404);
    assert.equal((await fetch(`${t.baseUrl}/classes/${c.id}/feed/${feed[0].id}/image`, { headers: { authorization: 'Bearer ' + outsider.token } })).status, 404);
    const other = await klass(1, false);
    assert.equal((await fetch(`${t.baseUrl}/classes/${other.c.id}/feed/${feed[0].id}/image`, { headers: { authorization: 'Bearer ' + other.ps[0].token } })).status, 404, 'a post id from another class');
  });

  it('PNG renderer unit: draws within the canvas and handles single points', async () => {
    const png = await renderBoardPng([{ c: '#000000', w: 4, p: [[0.5, 0.5]] }, { c: '#ff0000', w: 2, p: [[0, 0], [1, 1]] }]);
    assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
    assert.ok(png.length > 100);
  });
});
