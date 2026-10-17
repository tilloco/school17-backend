import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { ClockService } from '../common/clock';
import { FakePdfRenderer, PDF_RENDERER } from '../files/pdf-renderer';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makeJpeg, makePdf, makeTeacher, makeUser, TestApp, TestUser, uploadFile } from '../testing/harness';
import { ClassFilesService, validateStrokes } from './class-files.service';

const START = '2026-11-05T10:00:00.000Z';
const at = (offsetMin: number) => new Date(new Date(START).getTime() + offsetMin * 60_000);
const pdfWithPages = (n: number, name = 'book.pdf') => ({ name, mime: 'application/pdf', bytes: makePdf({ extra: Array.from({ length: n - 1 }, (_, i) => `${10 + i} 0 obj<</Type/Page/Parent 2 0 R>>endobj\n`).join('') }), purpose: 'CLASS_FILE' });

describe('class PDF presenter and library (R5, integration)', () => {
  let t: TestApp;
  let clock: ClockService;
  let svc: ClassFilesService;
  let fake: FakePdfRenderer;
  let admin: { id: string; token: string };

  async function klass(pupils = 2) {
    clock.set(new Date('2026-11-02T00:00:00Z'));
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const c = (await api(t, x.user.token).post('/classes', { title: 'Math', subject: 'Math', capacity: 30, oneOffStartAt: START })).body;
    const ps: TestUser[] = [];
    for (let i = 0; i < pupils; i++) {
      const u = await makeUser(t, Role.STUDENT);
      await api(t, u.token).post('/classes/join', { code: c.joinCode });
      ps.push(u);
    }
    const sid = (await api(t, x.user.token).get(`/classes/${c.id}/sessions`)).body[0].id as string;
    return { x, c, ps, sid };
  }
  async function addFile(x: { user: TestUser }, classId: string, pages = 3, extra: object = {}) {
    const up = await uploadFile(t, x.user, pdfWithPages(pages));
    assert.equal(up.complete?.status, 200, JSON.stringify(up.complete?.body ?? up.init.body));
    const r = await api(t, x.user.token).post(`/classes/${classId}/files`, { fileId: up.fileId, ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await svc.drain();
    return { id: r.body.id as string, fileId: up.fileId as string };
  }
  async function live(sid: string, x: { user: TestUser }) {
    clock.set(at(-5));
    assert.equal((await api(t, x.user.token).post(`/class-sessions/${sid}/start`)).status, 200);
  }

  before(async () => {
    t = await createTestApp();
    clock = t.app.get(ClockService);
    svc = t.app.get(ClassFilesService);
    fake = t.app.get(PDF_RENDERER) as FakePdfRenderer;
    admin = await makeAdmin(t);
  });
  after(async () => {
    delete process.env.TEACHER_STORAGE_QUOTA_BYTES;
    delete process.env.DISK_MIN_FREE_BYTES;
    delete process.env.PDF_MAX_PAGES;
    clock.set(null);
    await t.close();
  });

  it('protected class: members cannot download files or non-image channel attachments; the teacher still can; switching it off restores access', async () => {
    const { x, c, ps } = await klass(1);
    const bytes = Buffer.from('secret paid material '.repeat(40));
    const up = await uploadFile(t, x.user, { purpose: 'CLASS_FILE', name: 'paid.zip', mime: 'application/zip', bytes });
    const r = await api(t, x.user.token).post(`/classes/${c.id}/files`, { fileId: up.fileId });
    assert.equal(r.status, 201);
    const dl = (u: TestUser) => api(t, u.token).post(`/classes/${c.id}/files/${r.body.id}/download-url`, {});
    assert.equal((await dl(ps[0])).status, 200, 'open by default');
    assert.equal((await api(t, x.user.token).patch(`/classes/${c.id}`, { protectContent: true })).status, 200);
    assert.equal((await api(t, ps[0].token).get(`/classes/${c.id}`)).body.protectContent, true, 'members can read the flag (the app blocks screenshots)');
    const blocked = await dl(ps[0]);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'DOWNLOAD_OFF');
    assert.equal((await api(t, ps[0].token).post('/files/' + up.fileId + '/download-url', {})).status, 404, 'no way around it through the generic file route');
    assert.equal((await dl(x.user)).status, 200, 'the teacher keeps access');
    assert.equal((await api(t, x.user.token).patch(`/classes/${c.id}`, { protectContent: false })).status, 200);
    assert.equal((await dl(ps[0])).status, 200);
  });

  it('any file type in a class: a zip lands as ready (no pages), pupils list and download it', async () => {
    const { x, c, ps } = await klass(1);
    const bytes = Buffer.from('PK-not-really-a-zip-but-any-bytes-are-fine'.repeat(50));
    const up = await uploadFile(t, x.user, { purpose: 'CLASS_FILE', name: 'week1.zip', mime: 'application/zip', bytes });
    assert.equal(up.complete?.status, 200, JSON.stringify(up.complete?.body));
    const r = await api(t, x.user.token).post(`/classes/${c.id}/files`, { fileId: up.fileId });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.renderStatus, 'READY');
    assert.equal(r.body.mime, 'application/zip');
    const list = (await api(t, ps[0].token).get(`/classes/${c.id}/files`)).body;
    assert.equal(list[0].name, 'week1.zip');
    const dl = await api(t, ps[0].token).post(`/classes/${c.id}/files/${r.body.id}/download-url`, {});
    assert.equal(dl.status, 200, JSON.stringify(dl.body));
    const got = await fetch(t.baseUrl + dl.body.url);
    assert.ok(Buffer.from(await got.arrayBuffer()).equals(bytes));
  });

  it('route matrix', async () => {
    const actors = { STUDENT: await makeUser(t, Role.STUDENT), GUARDIAN: await makeUser(t, Role.GUARDIAN), TEACHER: (await makeTeacher(t, { approve: { adminToken: admin.token } })).user, adminToken: admin.token };
    const id = '11111111-1111-4111-8111-111111111111';
    const p = `/classes/${id}/files`;
    const failures = await checkRouteMatrix(t, actors, [
      { method: 'POST', path: p, body: { fileId: id }, allowed: ['TEACHER'] },
      { method: 'GET', path: p, allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'PATCH', path: `${p}/${id}`, body: { allowDownload: false }, allowed: ['TEACHER'] },
      { method: 'DELETE', path: `${p}/${id}`, allowed: ['TEACHER'] },
      { method: 'GET', path: `${p}/${id}/pages/1`, allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'GET', path: `${p}/${id}/pages/1/annotations`, allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'PUT', path: `${p}/${id}/pages/1/annotations`, body: { strokes: [] }, allowed: ['TEACHER'] },
      { method: 'POST', path: `${p}/${id}/download-url`, allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'POST', path: `${p}/${id}/report`, body: { reason: 'COPYRIGHT' }, allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'POST', path: `/class-sessions/${id}/present`, body: {}, allowed: ['TEACHER'] },
      { method: 'POST', path: `/class-sessions/${id}/present/stop`, allowed: ['TEACHER'] },
    ]);
    assert.deepEqual(failures, []);
    const adminFailures = await checkRouteMatrix(t, actors, [
      { method: 'POST', path: `/admin/market/class-files/${id}/takedown`, body: {}, allowed: [], scope: 'admin' } as any,
      { method: 'GET', path: '/admin/market/storage', allowed: [], scope: 'admin' } as any,
    ]);
    assert.deepEqual(adminFailures, []);
  });

  it('upload -> add -> progressive render -> pages served as WebP in three sizes; members only', async () => {
    const { x, c, ps } = await klass(2);
    const outsider = await makeUser(t);
    const other = await klass(1); // boshqa sinfning o'quvchisi
    const f = await addFile(x, c.id, 3);
    const list = (await api(t, ps[0].token).get(`/classes/${c.id}/files`)).body;
    assert.equal(list.length, 1);
    assert.equal(list[0].renderStatus, 'READY');
    assert.equal(list[0].pageCount, 3);
    assert.equal(list[0].renderedPages, 3);
    const get = (tok: string, n: number, size = 'full') => fetch(`${t.baseUrl}/classes/${c.id}/files/${f.id}/pages/${n}?size=${size}`, { headers: { authorization: 'Bearer ' + tok } });
    const full = await get(ps[0].token, 1);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'image/webp');
    assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
    const fb = Buffer.from(await full.arrayBuffer());
    assert.equal(fb.subarray(0, 4).toString('latin1'), 'RIFF');
    assert.equal(fb.subarray(8, 12).toString('latin1'), 'WEBP');
    const small = Buffer.from(await (await get(ps[0].token, 1, 'small')).arrayBuffer());
    const thumb = Buffer.from(await (await get(ps[0].token, 1, 'thumb')).arrayBuffer());
    assert.ok(thumb.length < small.length && small.length < fb.length, 'smaller sizes are smaller');
    assert.equal((await get(ps[0].token, 4)).status, 404, 'no such page');
    assert.equal((await get(x.user.token, 2)).status, 200, 'the teacher sees pages');
    assert.equal((await get(outsider.token, 1)).status, 404);
    assert.equal((await get(other.ps[0].token, 1)).status, 404, 'a pupil of another class cannot read the pages');
    assert.equal((await get(other.x.user.token, 1)).status, 404, 'nor can another teacher');
    // qidiruv
    assert.equal((await api(t, ps[0].token).get(`/classes/${c.id}/files?q=BOO`)).body.length, 1);
    assert.equal((await api(t, ps[0].token).get(`/classes/${c.id}/files?q=zzz`)).body.length, 0);
    // vasiy
    const g = await makeUser(t, Role.GUARDIAN);
    const minor = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05' });
    await t.prisma.guardianLink.create({ data: { guardianId: g.id, studentId: minor.id, status: 'ACTIVE' } });
    await api(t, g.token).post('/classes/join', { code: c.joinCode, studentId: minor.id });
    assert.equal((await get(g.token, 1)).status, 200, 'a guardian of an enrolled child');
  });

  it('only real PDFs are accepted: wrong magic bytes, wrong declared type, pupils and image types are refused; foreign and duplicate files cannot be added', async () => {
    const { x, c, ps } = await klass(1);
    const jpeg = await makeJpeg(10, 10, false);
    const fake1 = await uploadFile(t, x.user, { name: 'trick.pdf', mime: 'application/pdf', bytes: jpeg, purpose: 'CLASS_FILE' });
    assert.equal(fake1.complete.status, 422, 'a JPEG renamed .pdf is rejected by content sniffing');
    const text = await uploadFile(t, x.user, { name: 'notes.pdf', mime: 'application/pdf', bytes: Buffer.from('<html><script>alert(1)</script></html>'.padEnd(40, ' ')), purpose: 'CLASS_FILE' });
    assert.equal(text.complete.status, 422);
    const img = await uploadFile(t, x.user, { name: 'p.jpg', mime: 'image/jpeg', bytes: jpeg, purpose: 'CLASS_FILE' });
    assert.equal(img.init.status, 400, 'class files must be PDF');
    const asPupil = await uploadFile(t, ps[0], pdfWithPages(1));
    assert.equal(asPupil.init.status, 400, 'pupils cannot upload class files');
    const real = await uploadFile(t, x.user, pdfWithPages(2));
    assert.equal(real.complete.status, 200);
    assert.equal((await api(t, ps[0].token).post(`/classes/${c.id}/files`, { fileId: real.fileId })).status, 403, 'a pupil cannot add');
    const stranger = await makeTeacher(t, { approve: { adminToken: admin.token } });
    assert.equal((await api(t, stranger.user.token).post(`/classes/${c.id}/files`, { fileId: real.fileId })).status, 404, 'another teacher');
    const mine = await klass(0);
    assert.equal((await api(t, mine.x.user.token).post(`/classes/${mine.c.id}/files`, { fileId: real.fileId })).status, 404, 'a file you do not own');
    const msgFile = await uploadFile(t, x.user, { mime: 'image/jpeg', bytes: jpeg, purpose: 'MESSAGE_ATTACHMENT' });
    assert.equal((await api(t, x.user.token).post(`/classes/${c.id}/files`, { fileId: msgFile.fileId })).status, 404, 'wrong purpose');
    assert.equal((await api(t, x.user.token).post(`/classes/${c.id}/files`, { fileId: real.fileId })).status, 201);
    assert.equal((await api(t, x.user.token).post(`/classes/${c.id}/files`, { fileId: real.fileId })).body.code, 'ALREADY_ADDED');
    await svc.drain();
  });

  it('limits: teacher quota (admin can raise it), disk guard, page limit, and render failures retry then fail without exposing anything', async () => {
    const { x, c } = await klass(1);
    const pdf = pdfWithPages(1);
    process.env.TEACHER_STORAGE_QUOTA_BYTES = String(1000 + pdf.bytes.length + 10);
    const first = await uploadFile(t, x.user, pdf);
    assert.equal(first.complete.status, 200);
    const second = await uploadFile(t, x.user, pdf);
    assert.equal(second.init.status, 413);
    assert.equal(second.init.body.code, 'QUOTA_EXCEEDED');
    const raise = await api(t, admin.token).post(`/admin/market/teachers/${x.profileId}/storage-quota`, { mb: 5 });
    assert.equal(raise.status, 200, JSON.stringify(raise.body));
    assert.equal((await uploadFile(t, x.user, pdf)).complete.status, 200, 'raised quota applies');
    assert.equal((await api(t, x.user.token).post(`/admin/market/teachers/${x.profileId}/storage-quota`, { mb: 5000 })).status, 401, 'a teacher cannot raise it (admin guard)');
    delete process.env.TEACHER_STORAGE_QUOTA_BYTES;
    // disk
    process.env.DISK_MIN_FREE_BYTES = String(10 ** 15);
    const low = await uploadFile(t, x.user, pdf);
    assert.equal(low.init.status, 503);
    assert.equal(low.init.body.code, 'DISK_LOW');
    delete process.env.DISK_MIN_FREE_BYTES;
    // sahifalar chegarasi: darhol FAILED
    process.env.PDF_MAX_PAGES = '2';
    const big = await addFile(x, c.id, 4);
    let row = await t.prisma.classFile.findUniqueOrThrow({ where: { id: big.id } });
    assert.equal(row.renderStatus, 'FAILED');
    assert.equal(row.renderError, 'too_many_pages');
    delete process.env.PDF_MAX_PAGES;
    // vaqtinchalik xato: qayta uriniladi va muvaffaqiyatli bo'ladi
    fake.failNext = true;
    const flaky = await addFile(x, c.id, 2);
    row = await t.prisma.classFile.findUniqueOrThrow({ where: { id: flaky.id } });
    assert.equal(row.renderStatus, 'READY');
    assert.equal(row.renderAttempts, 2);
    // doimiy xato: 3 urinishdan keyin FAILED, rasmlar qoldirilmaydi
    const orig = fake.render.bind(fake);
    fake.render = async () => { throw Object.assign(new Error('boom'), { code: 'render_failed' }); };
    const broken = await addFile(x, c.id, 1);
    fake.render = orig;
    row = await t.prisma.classFile.findUniqueOrThrow({ where: { id: broken.id } });
    assert.equal(row.renderStatus, 'FAILED');
    assert.equal(row.renderedPages, 0);
  });

  it('presenting: teacher only, live only; pupils and late joiners read the state from the backend; pages must be ready', async () => {
    const { x, c, ps, sid } = await klass(2);
    const f = await addFile(x, c.id, 3);
    const present = (tok: string, body: object) => api(t, tok).post(`/class-sessions/${sid}/present`, body);
    clock.set(at(-60));
    assert.equal((await present(x.user.token, { fileId: f.id, page: 1 })).body.code, 'NOT_LIVE');
    await live(sid, x);
    assert.equal((await present(ps[0].token, { fileId: f.id, page: 1 })).status, 403);
    assert.equal((await present(x.user.token, { fileId: f.id, page: 9 })).body.code, 'PAGE_NOT_READY');
    assert.equal((await present(x.user.token, { fileId: f.id, page: 2 })).status, 200);
    const late = await makeUser(t);
    await api(t, late.token).post('/classes/join', { code: c.joinCode });
    const st = (await api(t, late.token).get(`/class-sessions/${sid}`)).body;
    assert.deepEqual({ page: st.presentation.page, pageCount: st.presentation.pageCount, fileId: st.presentation.fileId }, { page: 2, pageCount: 3, fileId: f.id }, 'a late joiner fetches the current page');
    assert.equal((await present(x.user.token, { fileId: f.id, page: 3 })).status, 200);
    assert.equal((await api(t, ps[1].token).get(`/class-sessions/${sid}`)).body.presentation.page, 3, 'a reconnecting client resyncs');
    const stranger = await makeTeacher(t, { approve: { adminToken: admin.token } });
    assert.equal((await present(stranger.user.token, { fileId: f.id, page: 1 })).status, 404);
    assert.equal((await api(t, x.user.token).post(`/class-sessions/${sid}/present/stop`)).status, 200);
    assert.equal((await api(t, ps[0].token).get(`/class-sessions/${sid}`)).body.presentation, null);
    // tayyor bo'lmagan fayl
    const pending = await t.prisma.classFile.create({ data: { classId: c.id, fileId: (await uploadFile(t, x.user, pdfWithPages(1))).fileId, uploaderId: x.user.id, name: 'later.pdf' } });
    assert.equal((await present(x.user.token, { fileId: pending.id, page: 1 })).body.code, 'PAGE_NOT_READY');
  });

  it('downloads: served as attachment only when the teacher allows; the pupil never gets the raw PDF otherwise', async () => {
    const { x, c, ps } = await klass(1);
    const f = await addFile(x, c.id, 1, { allowDownload: false });
    const dl = (tok: string) => api(t, tok).post(`/classes/${c.id}/files/${f.id}/download-url`);
    assert.equal((await dl(ps[0].token)).body.code, 'DOWNLOAD_OFF');
    assert.equal((await dl(x.user.token)).status, 200, 'the teacher can always download');
    assert.equal((await api(t, ps[0].token).post(`/files/${f.fileId}/download-url`, {})).status, 404, 'the generic files endpoint also refuses');
    assert.equal((await api(t, x.user.token).patch(`/classes/${c.id}/files/${f.id}`, { allowDownload: true })).status, 200);
    assert.equal((await api(t, ps[0].token).patch(`/classes/${c.id}/files/${f.id}`, { allowDownload: false })).status, 403);
    const ok = await dl(ps[0].token);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const blob = await fetch(ok.body.url.startsWith('/') ? t.baseUrl + ok.body.url : ok.body.url);
    assert.equal(blob.status, 200);
    assert.match(blob.headers.get('content-disposition') ?? '', /^attachment/);
    assert.equal(blob.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await dl((await makeUser(t)).token)).status, 404);
  });

  it('annotations: vector strokes validated and limited; teacher writes, members read, outsiders get nothing', async () => {
    const { x, c, ps } = await klass(1);
    const f = await addFile(x, c.id, 2);
    const url = `/classes/${c.id}/files/${f.id}/pages/1/annotations`;
    const good = [{ c: '#FF0000', w: 3, p: [[0.1, 0.2], [0.3, 0.4]] }];
    const put = await api(t, x.user.token).put(url, { strokes: good });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal((await api(t, ps[0].token).get(url)).body.strokes[0].c, '#ff0000');
    assert.equal((await api(t, ps[0].token).put(url, { strokes: good })).status, 403);
    assert.equal((await api(t, (await makeUser(t)).token).get(url)).status, 404);
    assert.equal((await api(t, x.user.token).put(`/classes/${c.id}/files/${f.id}/pages/9/annotations`, { strokes: good })).status, 400, 'page outside the file');
    for (const bad of [[{ c: 'red', w: 3, p: [[0, 0]] }], [{ c: '#ff0000', w: 99, p: [[0, 0]] }], [{ c: '#ff0000', w: 3, p: [[2, 0]] }], [{ c: '#ff0000', w: 3, p: [] }], [{ c: '#ff0000', w: 3, p: [[0, 'x']] }], Array.from({ length: 201 }, () => good[0])]) {
      assert.equal((await api(t, x.user.token).put(url, { strokes: bad })).status, 400);
    }
    assert.throws(() => validateStrokes([{ c: '#ffffff', w: 1, p: Array.from({ length: 501 }, () => [0.5, 0.5]) }]));
    assert.throws(() => validateStrokes(Array.from({ length: 11 }, () => ({ c: '#ffffff', w: 1, p: Array.from({ length: 500 }, () => [0.5, 0.5]) }))), 'total point cap');
  });

  it('report + takedown: members can report a file (incl. copyright), duplicates and own files are refused, admin takedown hides pages and stops the presentation, restore brings it back; admin sees disk use', async () => {
    const { x, c, ps, sid } = await klass(2);
    const f = await addFile(x, c.id, 2);
    await live(sid, x);
    await api(t, x.user.token).post(`/class-sessions/${sid}/present`, { fileId: f.id, page: 1 });
    const rep = await api(t, ps[0].token).post(`/classes/${c.id}/files/${f.id}/report`, { reason: 'COPYRIGHT', note: 'scanned book' });
    assert.equal(rep.status, 201, JSON.stringify(rep.body));
    assert.equal((await api(t, ps[0].token).post(`/classes/${c.id}/files/${f.id}/report`, { reason: 'COPYRIGHT' })).status, 409);
    assert.equal((await api(t, x.user.token).post(`/classes/${c.id}/files/${f.id}/report`, { reason: 'SPAM' })).status, 403);
    assert.equal((await api(t, (await makeUser(t)).token).post(`/classes/${c.id}/files/${f.id}/report`, { reason: 'SPAM' })).status, 404);
    const queue = (await api(t, admin.token).get('/admin/market/reports?status=OPEN&take=100')).body;
    const row = queue.find((r: any) => r.id === rep.body.id);
    assert.equal(row.targetType, 'CLASS_FILE');
    assert.equal(row.reason, 'COPYRIGHT');
    const td = await api(t, admin.token).post(`/admin/market/class-files/${f.id}/takedown`, { reason: 'copyright' });
    assert.equal(td.status, 200, JSON.stringify(td.body));
    const page = await fetch(`${t.baseUrl}/classes/${c.id}/files/${f.id}/pages/1`, { headers: { authorization: 'Bearer ' + ps[1].token } });
    assert.equal(page.status, 404);
    assert.equal((await api(t, ps[1].token).get(`/classes/${c.id}/files`)).body.length, 0);
    assert.equal((await api(t, ps[1].token).get(`/class-sessions/${sid}`)).body.presentation, null);
    assert.equal((await api(t, ps[1].token).post(`/files/${f.fileId}/download-url`, {})).status, 404);
    assert.equal((await api(t, admin.token).post(`/admin/market/class-files/${f.id}/restore`)).status, 200);
    assert.equal((await api(t, ps[1].token).get(`/classes/${c.id}/files`)).body.length, 1);
    const disk = (await api(t, admin.token).get('/admin/market/storage')).body;
    assert.ok(disk.totalBytes > 0 && disk.freeBytes > 0 && disk.minFreeBytes > 0, JSON.stringify(disk));
    assert.equal((await api(t, x.user.token).get('/admin/market/storage')).status, 401);
    assert.equal((await t.prisma.auditLog.count({ where: { action: 'class.file.takedown', targetId: f.id } })), 1);
  });

  it('delete: only the teacher; pages disappear and the file leaves the library', async () => {
    const { x, c, ps } = await klass(1);
    const f = await addFile(x, c.id, 2);
    assert.equal((await api(t, ps[0].token).del(`/classes/${c.id}/files/${f.id}`)).status, 403);
    assert.equal((await api(t, x.user.token).del(`/classes/${c.id}/files/${f.id}`)).status, 200);
    assert.equal((await api(t, x.user.token).get(`/classes/${c.id}/files`)).body.length, 0);
    const page = await fetch(`${t.baseUrl}/classes/${c.id}/files/${f.id}/pages/1`, { headers: { authorization: 'Bearer ' + x.user.token } });
    assert.equal(page.status, 404);
  });
});
