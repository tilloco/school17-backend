import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { api, createTestApp, makeAdmin, makeFile, makeJpeg, makeTeacher, makeUser, TestApp, uploadFile } from '../testing/harness';

describe('closed classes: join requests, payment photo, helpers (integration)', () => {
  let t: TestApp;
  let admin: { id: string; token: string };
  before(async () => { t = await createTestApp(); admin = await makeAdmin(t); });
  after(async () => { await t.close(); });

  const newClass = async (extra: Record<string, unknown> = {}) => {
    const teacher = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const made = await api(t, teacher.user.token).post('/classes', { title: 'SAT Math', subject: 'math', capacity: 30, joinApproval: true, requireProof: true, ...extra });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return { teacher, id: made.body.id as string, code: made.body.joinCode as string };
  };
  const proofOf = async (u: { id: string; token: string }) => {
    const up = await uploadFile(t, u as any, { mime: 'image/jpeg', bytes: await makeJpeg(), purpose: 'PAYMENT_PROOF', name: 'proof.jpg' });
    assert.ok(up.fileId, JSON.stringify(up.init?.body));
    return up.fileId as string;
  };
  const named = async (name: string, un: string) => {
    const u = await makeUser(t, Role.STUDENT, { name });
    assert.equal((await api(t, u.token).patch('/me', { username: un })).status, 200);
    return u;
  };

  it('a request needs the payment photo; the pupil waits; the teacher sees the photo and approves; then the pupil is a member', async () => {
    const { teacher, id, code } = await newClass();
    const pupil = await makeUser(t, Role.STUDENT, { name: 'Aziz Karimov', dateOfBirth: '2000-01-01' });
    const j = (body: object) => api(t, pupil.token).post('/classes/join', { code, ...body });
    assert.equal((await j({})).status, 400, 'no photo, no request');
    const r = await j({ proofFileId: await proofOf(pupil), note: 'Paid 150 000 via bank' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.pending, true);
    assert.equal((await j({ proofFileId: await proofOf(pupil) })).status, 409, 'one waiting request at a time');
    assert.equal((await api(t, pupil.token).get('/classes/' + id)).status, 404, 'waiting people are not members yet');
    assert.deepEqual((await api(t, pupil.token).get('/class-staff/my-requests')).body.map((x: any) => x.status), ['PENDING']);

    const list = (await api(t, teacher.user.token).get(`/class-staff/${id}/requests`)).body;
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'Aziz Karimov');
    assert.equal(list[0].hasProof, true);
    assert.equal(list[0].note, 'Paid 150 000 via bank');
    const photo = await fetch(t.baseUrl + `/class-staff/${id}/requests/${list[0].id}/proof`, { headers: { authorization: 'Bearer ' + teacher.user.token } });
    assert.equal(photo.status, 200, 'the teacher sees the payment photo');
    const stranger = await makeUser(t, Role.STUDENT);
    assert.equal((await fetch(t.baseUrl + `/class-staff/${id}/requests/${list[0].id}/proof`, { headers: { authorization: 'Bearer ' + stranger.token } })).status, 404);
    assert.equal((await api(t, pupil.token).get(`/class-staff/${id}/requests`)).status, 404, 'the pupil cannot read the list');

    assert.equal((await api(t, teacher.user.token).post(`/class-staff/${id}/requests/${list[0].id}/approve`)).status, 200);
    assert.equal((await api(t, pupil.token).get('/classes/' + id)).status, 200, 'now a member');
    assert.equal((await api(t, teacher.user.token).get('/classes/' + id)).body.enrolled, 1);
    assert.equal((await api(t, teacher.user.token).post(`/class-staff/${id}/requests/${list[0].id}/approve`)).status, 404, 'cannot approve twice');
  });

  it('decline keeps them out and they may ask again; a full class cannot approve', async () => {
    const { teacher, id, code } = await newClass({ capacity: 1, requireProof: false });
    const a = await makeUser(t, Role.STUDENT, { dateOfBirth: '2000-01-01' });
    const b = await makeUser(t, Role.STUDENT, { dateOfBirth: '2000-01-01' });
    assert.equal((await api(t, a.token).post('/classes/join', { code })).body.pending, true);
    assert.equal((await api(t, b.token).post('/classes/join', { code })).body.pending, true);
    const reqs = (await api(t, teacher.user.token).get(`/class-staff/${id}/requests`)).body;
    assert.equal(reqs.length, 2);
    assert.equal((await api(t, teacher.user.token).post(`/class-staff/${id}/requests/${reqs[0].id}/approve`)).status, 200);
    const full = await api(t, teacher.user.token).post(`/class-staff/${id}/requests/${reqs[1].id}/approve`);
    assert.equal(full.status, 409);
    assert.equal(full.body.code, 'CLASS_FULL');
    assert.equal((await api(t, teacher.user.token).post(`/class-staff/${id}/requests/${reqs[1].id}/decline`)).status, 200);
    assert.equal((await api(t, b.token).get('/class-staff/my-requests')).body[0].status, 'DECLINED');
    assert.equal((await api(t, b.token).post('/classes/join', { code })).body.pending, true, 'a declined person may ask again');
  });

  it('helpers: named by @username, adults only, up to five; they approve requests, check payments and moderate, and nothing more', async () => {
    const { teacher, id, code } = await newClass({ requireProof: false, priceMinor: 15_000_000, priceModel: 'MONTHLY' });
    const helper = await named('Dilnoza Helper', `helper_${Math.random().toString(36).slice(2, 8)}`);
    const me = (await api(t, helper.token).get('/me')).body;
    const minor = await makeUser(t, Role.STUDENT, { name: 'Young One', dateOfBirth: '2012-01-01' });
    await api(t, minor.token).patch('/me', { username: `kid_${Math.random().toString(36).slice(2, 8)}` });
    const kid = (await api(t, minor.token).get('/me')).body;
    const base = `/class-staff/${id}/helpers`;
    assert.equal((await api(t, helper.token).post(base, { username: me.username })).status, 403, 'only the teacher names helpers');
    assert.equal((await api(t, teacher.user.token).post(base, { username: 'nobody_here_x' })).status, 404);
    assert.equal((await api(t, teacher.user.token).post(base, { username: kid.username })).status, 403, 'a helper must be an adult');
    assert.equal((await api(t, teacher.user.token).post(base, { username: '@' + me.username })).status, 201);

    const mine = (await api(t, helper.token).get('/class-staff/mine')).body;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].classId, id);
    assert.equal((await api(t, helper.token).get('/classes/' + id)).body.role, 'assistant', 'the helper can open the class');

    const pupil = await makeUser(t, Role.STUDENT, { name: 'Waiting Pupil', dateOfBirth: '2000-01-01' });
    assert.equal((await api(t, pupil.token).post('/classes/join', { code })).body.pending, true);
    const reqs = (await api(t, helper.token).get(`/class-staff/${id}/requests`)).body;
    assert.equal(reqs.length, 1);
    assert.equal((await api(t, helper.token).get('/class-staff/mine')).body[0].pendingRequests, 1);
    assert.equal((await api(t, helper.token).post(`/class-staff/${id}/requests/${reqs[0].id}/approve`)).status, 200, 'a helper approves');

    // what a helper may NOT do
    assert.ok([403, 404].includes((await api(t, helper.token).patch('/classes/' + id, { title: 'Hacked' })).status), 'no editing');
    assert.equal((await api(t, helper.token).get(base)).status, 403, 'cannot read or change the helper list');
    assert.equal((await api(t, helper.token).post('/classes/' + id + '/cancel', {})).status >= 400, true);

    // payments board
    const board = await api(t, helper.token).get(`/class-staff/${id}/money`);
    assert.equal(board.status, 200, JSON.stringify(board.body));

    // channel: the helper posts, the post carries the assistant badge, and the helper can pin
    const post = await api(t, helper.token).post(`/classes/${id}/channel`, { body: 'Welcome! Ask me anything.' });
    assert.equal(post.status, 201, JSON.stringify(post.body));
    assert.equal((await api(t, helper.token).put(`/classes/${id}/channel/${post.body.id}/pin`, {})).status, 200, 'a helper pins');
    const seen = (await api(t, pupil.token).get(`/classes/${id}/channel`)).body.items;
    assert.equal(seen.find((x: any) => x.id === post.body.id).author.assistant, true);

    // permissions can be limited and the helper can be removed
    assert.equal((await api(t, teacher.user.token).post(base, { username: me.username, canPayments: false })).status, 201);
    assert.equal((await api(t, helper.token).get(`/class-staff/${id}/money`)).status, 404, 'payments switched off');
    assert.equal((await api(t, teacher.user.token).del(`${base}/${me.id}`)).status, 200);
    assert.equal((await api(t, helper.token).get(`/class-staff/${id}/requests`)).status, 404, 'removed helpers lose access');
    assert.equal((await api(t, helper.token).get('/classes/' + id)).status, 404);
  });

  it('at most five helpers; deleting an account removes its helper rows and waiting requests', async () => {
    const { teacher, id, code } = await newClass({ requireProof: false });
    const base = `/class-staff/${id}/helpers`;
    const users = [];
    for (let i = 0; i < 6; i++) users.push(await named(`Helper ${i}`, `max_${i}_${Math.random().toString(36).slice(2, 7)}`));
    for (let i = 0; i < 5; i++) assert.equal((await api(t, teacher.user.token).post(base, { username: (await api(t, users[i].token).get('/me')).body.username })).status, 201);
    const over = await api(t, teacher.user.token).post(base, { username: (await api(t, users[5].token).get('/me')).body.username });
    assert.equal(over.status, 409);
    assert.equal(over.body.code, 'TOO_MANY_HELPERS');

    const asker = await makeUser(t, Role.STUDENT, { dateOfBirth: '2000-01-01' });
    assert.equal((await api(t, asker.token).post('/classes/join', { code })).body.pending, true);
    assert.equal((await api(t, asker.token).post('/me/delete', { confirm: 'DELETE' })).status, 200);
    assert.equal(await t.prisma.classEnrollment.count({ where: { pupilId: asker.id } }), 0, 'the waiting request goes with the account');
    assert.equal((await api(t, users[0].token).post('/me/delete', { confirm: 'DELETE' })).status, 200);
    assert.equal(await t.prisma.classHelper.count({ where: { userId: users[0].id } }), 0);
  });
});

describe('recorded lessons play inside the app (integration)', () => {
  let t: TestApp;
  let admin: { id: string; token: string };
  before(async () => { t = await createTestApp(); admin = await makeAdmin(t); });
  after(async () => { await t.close(); });

  it('a member streams a video even when downloads are off; documents are refused; strangers get nothing', async () => {
    const teacher = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const made = await api(t, teacher.user.token).post('/classes', { title: 'Recorded SAT course', subject: 'math', capacity: 30, protectContent: true });
    const id = made.body.id as string;
    const pupil = await makeUser(t, Role.STUDENT, { dateOfBirth: '2000-01-01' });
    assert.equal((await api(t, pupil.token).post('/classes/join', { code: made.body.joinCode })).status, 200);
    const stranger = await makeUser(t, Role.STUDENT, { dateOfBirth: '2000-01-01' });

    const mk = async (mime: string, name: string) => {
      const sf = await makeFile(t, teacher.user.id, { purpose: 'CLASS_FILE' });
      await t.prisma.storedFile.update({ where: { id: sf.id }, data: { finalMime: mime, mime, originalName: name } });
      const r = await api(t, teacher.user.token).post(`/classes/${id}/files`, { fileId: sf.id });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.id as string;
    };
    const video = await mk('video/mp4', 'lesson-01.mp4');
    const doc = await mk('application/zip', 'notes.zip');

    const stream = await api(t, pupil.token).post(`/classes/${id}/files/${video}/stream-url`, {});
    assert.equal(stream.status, 200, JSON.stringify(stream.body));
    assert.ok(stream.body.url, 'a short-lived address comes back');
    assert.equal(stream.body.mime, 'video/mp4');
    assert.equal((await api(t, pupil.token).post(`/classes/${id}/files/${video}/download-url`, {})).status, 403, 'but no download in a protected class');
    const notVideo = await api(t, pupil.token).post(`/classes/${id}/files/${doc}/stream-url`, {});
    assert.equal(notVideo.status, 400);
    assert.equal(notVideo.body.code, 'NOT_A_VIDEO');
    assert.equal((await api(t, stranger.token).post(`/classes/${id}/files/${video}/stream-url`, {})).status, 404);
    assert.equal((await fetch(t.baseUrl + `/classes/${id}/files/${video}/stream-url`, { method: 'POST' })).status, 401);
  });
});
