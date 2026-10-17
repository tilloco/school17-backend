import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { api, createTestApp, makeAdmin, makeFile, makeTeacher, makeUser, TestApp } from '../testing/harness';

describe('class channel (everyone in the class writes, integration)', () => {
  let t: TestApp;
  let admin: { id: string; token: string };
  before(async () => {
    t = await createTestApp();
    admin = await makeAdmin(t);
  });
  after(async () => {
    await t.close();
  });

  async function setup(body: Record<string, unknown> = {}) {
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const c = (await api(t, x.user.token).post('/classes', { title: 'Math', subject: 'Math', ...body })).body;
    const a = await makeUser(t, Role.STUDENT, { name: 'Aziz Tursunov' });
    const b = await makeUser(t, Role.STUDENT, { name: 'Madina Ergasheva' });
    for (const u of [a, b]) assert.equal((await api(t, u.token).post('/classes/join', { code: c.joinCode })).status, 200);
    const stranger = await makeUser(t, Role.STUDENT);
    return { x, c, a, b, stranger, base: `/classes/${c.id}/channel` };
  }

  it('a class can be created without a pupil limit (the limit is optional)', async () => {
    const { c } = await setup();
    assert.ok(c.capacity >= 100, `capacity ${c.capacity}`);
  });

  it('the teacher can add a lesson at any time, with or without a weekly schedule', async () => {
    const { x, a, c } = await setup();
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    assert.equal((await api(t, a.token).post(`/classes/${c.id}/sessions`, { startAt: soon })).status, 403);
    assert.equal((await api(t, x.user.token).post(`/classes/${c.id}/sessions`, { startAt: new Date(Date.now() - 1000).toISOString() })).status, 400);
    assert.equal((await api(t, x.user.token).post(`/classes/${c.id}/sessions`, { startAt: soon, durationMin: 45 })).status, 201);
    const list = (await api(t, a.token).get(`/classes/${c.id}/sessions`)).body;
    assert.equal(list.length, 1);
    assert.equal(await t.prisma.notification.count({ where: { userId: a.id, type: 'class.session_added' } }), 1);
  });

  it('pins: only the teacher pins (many), everyone sees them, the list is newest first; the 101st pin needs an unpin; info shows teacher, lessons and the protection flag', async () => {
    const { x, a, stranger, base, c } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await api(t, x.user.token).post(base, { body: `Rule ${i}` })).body.id);
    const mine = (await api(t, a.token).post(base, { body: 'my question' })).body.id;
    assert.equal((await api(t, a.token).put(`${base}/${ids[0]}/pin`)).status, 403, 'a pupil cannot pin');
    assert.equal((await api(t, stranger.token).put(`${base}/${ids[0]}/pin`)).status, 404);
    for (const id of ids) assert.equal((await api(t, x.user.token).put(`${base}/${id}/pin`)).status, 200);
    const pins = (await api(t, a.token).get(`${base}/pins`)).body.items;
    assert.deepEqual(pins.map((p: any) => p.body), ['Rule 2', 'Rule 1', 'Rule 0']);
    assert.equal(pins[0].pinned, true);
    assert.equal((await api(t, a.token).get(base)).body.items.find((m: any) => m.id === mine).pinned, false);
    assert.equal((await api(t, x.user.token).del(`${base}/${ids[1]}/pin`)).status, 200);
    assert.equal((await api(t, a.token).get(`${base}/pins`)).body.items.length, 2);
    // 100 ta chegara: 101-chisi uchun eskisini olib tashlash kerak
    const rows = Array.from({ length: 97 }, (_, i) => ({ classId: c.id, authorId: x.user.id, body: `bulk ${i}`, pinnedAt: new Date(Date.now() - i * 1000) }));
    await t.prisma.classChannelPost.createMany({ data: rows });
    assert.equal((await api(t, x.user.token).put(`${base}/${ids[1]}/pin`)).status, 200, 'the 100th pin');
    const extra = (await api(t, x.user.token).post(base, { body: 'one more' })).body.id;
    const over = await api(t, x.user.token).put(`${base}/${extra}/pin`);
    assert.equal(over.status, 409);
    assert.equal(over.body.code, 'PIN_LIMIT');
    // kanal haqida
    await api(t, x.user.token).post(`/classes/${c.id}/sessions`, { startAt: new Date(Date.now() + 86_400_000).toISOString(), durationMin: 45 });
    await api(t, x.user.token).patch(`/classes/${c.id}`, { protectContent: true });
    const info = (await api(t, a.token).get(`${base}/info`)).body;
    assert.equal(info.title, 'Math');
    assert.equal(info.protectContent, true);
    assert.equal(info.role, 'pupil');
    assert.equal(info.teacher.id, x.user.id);
    assert.equal(info.upcoming.length, 1);
    assert.equal(info.pinsCount, 100);
    assert.equal((await api(t, stranger.token).get(`${base}/info`)).status, 404);
  });

  it('teacher and pupils write; strangers get 404; messages come back in order with author names', async () => {
    const { x, a, b, stranger, base } = await setup();
    assert.equal((await api(t, x.user.token).post(base, { body: 'Welcome to the class!' })).status, 201);
    assert.equal((await api(t, a.token).post(base, { body: 'Hello teacher' })).status, 201);
    assert.equal((await api(t, b.token).post(base, { body: '   ' })).status, 400);
    for (const u of [stranger]) {
      assert.equal((await api(t, u.token).get(base)).status, 404);
      assert.equal((await api(t, u.token).post(base, { body: 'hi' })).status, 404);
    }
    const list = (await api(t, b.token).get(base)).body.items;
    assert.deepEqual(list.map((m: any) => m.body), ['Welcome to the class!', 'Hello teacher']);
    assert.equal(list[0].author.teacher, true);
    assert.equal(list[1].author.name, 'Aziz Tursunov');
    assert.equal(list[1].mine, false);
    const after = (await api(t, a.token).get(`${base}?after=${list[0].seq}`)).body.items;
    assert.equal(after.length, 1);
    assert.equal(after[0].mine, true);
  });

  it('files: a pupil sends a photo, class members can open it, strangers cannot', async () => {
    const { x, a, b, stranger, base } = await setup();
    const f = await makeFile(t, a.id, { purpose: 'MESSAGE_ATTACHMENT' });
    await t.prisma.storedFile.update({ where: { id: f.id }, data: { mime: 'image/jpeg', originalName: 'photo.jpg' } });
    const sent = await api(t, a.token).post(base, { fileId: f.id });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(sent.body.file.image, true);
    assert.equal((await api(t, a.token).post(base, { fileId: f.id })).status, 409, 'a file is sent once');
    const other = await makeFile(t, b.id, { purpose: 'MESSAGE_ATTACHMENT' });
    assert.equal((await api(t, a.token).post(base, { fileId: other.id })).status, 404, "someone else's file cannot be attached");
    for (const u of [x.user, b]) assert.equal((await api(t, u.token).post(`/files/${f.id}/download-url`, {})).status, 200);
    assert.ok([403, 404].includes((await api(t, stranger.token).post(`/files/${f.id}/download-url`, {})).status));
  });

  it('delete: authors remove their own, the teacher removes any, other pupils cannot', async () => {
    const { x, a, b, base } = await setup();
    const m1 = (await api(t, a.token).post(base, { body: 'one' })).body;
    const m2 = (await api(t, a.token).post(base, { body: 'two' })).body;
    assert.equal((await api(t, b.token).del(`${base}/${m1.id}`)).status, 403);
    assert.equal((await api(t, a.token).del(`${base}/${m1.id}`)).status, 200);
    assert.equal((await api(t, x.user.token).del(`${base}/${m2.id}`)).status, 200);
    assert.equal((await api(t, b.token).get(base)).body.items.length, 0);
  });

  it('contact details are refused when the class has pupils under 18', async () => {
    const { x, base, c } = await setup();
    const g = await makeUser(t, Role.GUARDIAN);
    const kid = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05', name: 'Kid Karimov' });
    await t.prisma.guardianLink.create({ data: { guardianId: g.id, studentId: kid.id, status: 'ACTIVE' } });
    assert.equal((await api(t, g.token).post('/classes/join', { code: c.joinCode, studentId: kid.id })).status, 200);
    const r = await api(t, x.user.token).post(base, { body: 'call me on +998 90 123 45 67' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'CONTACT_INFO_NOT_ALLOWED');
  });
});
