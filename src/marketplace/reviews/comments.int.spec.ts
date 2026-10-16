import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { api, createTestApp, makeAdmin, makeTeacher, makeUser, TestApp } from '../testing/harness';

describe('usernames, people search and public comments (integration)', () => {
  let t: TestApp;
  let admin: { id: string; token: string };
  before(async () => {
    t = await createTestApp();
    admin = await makeAdmin(t);
  });
  after(async () => {
    await t.close();
  });

  it('usernames: set once per person, unique, lower-case, rules and reserved words', async () => {
    const a = await makeUser(t, Role.STUDENT);
    const b = await makeUser(t, Role.STUDENT);
    const un = `aziz_${Math.random().toString(36).slice(2, 8)}`;
    const ok = await api(t, a.token).patch('/me', { username: `@${un.toUpperCase()}` });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.username, un);
    assert.equal((await api(t, b.token).patch('/me', { username: un })).status, 409);
    for (const bad of ['ab', '1abc', 'has space', 'a-b-c', 'x'.repeat(21), 'admin', 'School17']) assert.equal((await api(t, b.token).patch('/me', { username: bad })).status, 400, bad);
    assert.equal((await api(t, a.token).get('/me')).body.username, un);
  });

  it('pupils find a teacher by a part of the username and see rating, bio and subjects', async () => {
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const pupil = await makeUser(t, Role.STUDENT);
    const un = `ustoz_${Math.random().toString(36).slice(2, 8)}`;
    assert.equal((await api(t, x.user.token).patch('/me', { username: un })).status, 200);
    const found = (await api(t, pupil.token).get(`/teachers?q=${un.slice(0, 9)}`)).body.items;
    assert.ok(found.some((i: any) => i.id === x.profileId && i.username === un), JSON.stringify(found.map((i: any) => i.username)));
    const prof = (await api(t, pupil.token).get(`/teachers/${x.profileId}`)).body;
    assert.equal(prof.username, un);
    assert.ok(prof.bio.length > 10 && prof.rating);
  });

  it('comments: anyone but teachers writes one; ex-students are marked; contact details refused; edit replaces; delete works', async () => {
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const stranger = await makeUser(t, Role.STUDENT, { name: 'Sardor Nazarov' });
    const exPupil = await makeUser(t, Role.STUDENT, { name: 'Madina Ergasheva' });
    const c = (await api(t, x.user.token).post('/classes', { title: 'Math', subject: 'Math' })).body;
    assert.equal((await api(t, exPupil.token).post('/classes/join', { code: c.joinCode })).status, 200);
    const base = `/teachers/${x.profileId}/comments`;

    assert.equal((await api(t, stranger.token).post(base, { text: 'ok' })).status, 400, 'too short');
    assert.equal((await api(t, stranger.token).post(base, { text: 'Call me +998 90 123 45 67' })).status, 400);
    assert.equal((await api(t, x.user.token).post(base, { text: 'I am great' })).status, 403, 'not on your own profile');
    const other = await makeTeacher(t, { approve: { adminToken: admin.token } });
    assert.equal((await api(t, other.user.token).post(base, { text: 'Rival comment here' })).status, 403, 'not from other teachers');

    assert.equal((await api(t, stranger.token).post(base, { text: 'Clear explanations, thank you' })).status, 201);
    assert.equal((await api(t, exPupil.token).post(base, { text: 'My grades went up' })).status, 201);
    const list = (await api(t, stranger.token).get(base)).body;
    assert.equal(list.items.length, 2);
    const by = (n: string) => list.items.find((i: any) => i.text.startsWith(n));
    assert.equal(by('Clear').exStudent, false);
    assert.equal(by('My grades').exStudent, true);
    assert.equal(by('Clear').mine, true);
    assert.equal(by('Clear').author, 'Sardor N.', 'only first name and initial');

    assert.equal((await api(t, stranger.token).post(base, { text: 'Edited: even better now' })).status, 201);
    const again = (await api(t, stranger.token).get(base)).body;
    assert.equal(again.items.length, 2, 'one comment per person');
    assert.equal(again.mine.text, 'Edited: even better now');
    assert.equal((await api(t, stranger.token).del(`${base}/mine`)).status, 200);
    assert.equal((await api(t, stranger.token).get(base)).body.items.length, 1);
  });

  it('teachers can look up pupils by the start of a username (3+ letters); no contact data is returned', async () => {
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const pupil = await makeUser(t, Role.STUDENT, { name: 'Zilola Qodirova' });
    const un = `zilola_${Math.random().toString(36).slice(2, 6)}`;
    await api(t, pupil.token).patch('/me', { username: un });
    assert.deepEqual((await api(t, x.user.token).get('/teachers/me/find-students?q=zi')).body, []);
    const r = (await api(t, x.user.token).get(`/teachers/me/find-students?q=@${un}`)).body;
    assert.deepEqual(Object.keys(r[0]).sort(), ['name', 'username']);
    assert.equal(r[0].username, un);
    assert.equal((await api(t, pupil.token).get('/teachers/me/find-students?q=zil')).status, 403);
  });
});
