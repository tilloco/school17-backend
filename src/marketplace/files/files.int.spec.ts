import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { ClockService } from '../common/clock';
import { SCAN_PROVIDER } from './scanner';
import { OBJECT_STORAGE } from './storage';
import {
  api, checkRouteMatrix, CHUNK, createTestApp, makeAdmin, makeJpeg, makePdf, makeTeacher, makeThread, makeUser, TestApp, uploadFile,
} from '../testing/harness';

const NOW = new Date('2026-11-02T00:00:00Z');

describe('files (integration)', () => {
  let t: TestApp;
  let clock: ClockService;
  let admin: { id: string; token: string };
  const sharp = require('sharp');

  before(async () => {
    t = await createTestApp();
    clock = t.app.get(ClockService);
    clock.set(NOW);
    admin = await makeAdmin(t);
  });
  after(async () => {
    clock.set(null);
    delete process.env.FILE_USER_QUOTA_BYTES;
    delete process.env.FILE_SCAN_REQUIRED;
    await t.close();
  });

  it('route matrix', async () => {
    const actors = { STUDENT: await makeUser(t, Role.STUDENT), GUARDIAN: await makeUser(t, Role.GUARDIAN), TEACHER: await makeUser(t, Role.TEACHER), adminToken: admin.token };
    const id = '11111111-1111-4111-8111-111111111111';
    const failures = await checkRouteMatrix(t, actors, [
      { method: 'POST', path: '/files/init', body: { purpose: 'AVATAR', name: 'a.png', size: 10, mime: 'image/png' }, allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'GET', path: '/files/quota', allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'GET', path: '/files/' + id, allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'POST', path: '/files/' + id + '/download-url', body: {}, allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'POST', path: '/admin/market/files/' + id + '/download-url', scope: 'admin', allowed: ['ADMIN'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('init rejects disallowed types, oversize, bad purpose, student credentials', async () => {
    const u = await makeUser(t);
    const c = api(t, u.token);
    for (const mime of ['image/svg+xml', 'text/html', 'application/x-msdownload', 'application/zip', 'application/javascript', 'image/gif']) {
      const r = await c.post('/files/init', { purpose: 'AVATAR', name: 'x', size: 100, mime });
      assert.equal(r.status, 400, mime);
      assert.equal(r.body.code, 'TYPE_NOT_ALLOWED');
    }
    assert.equal((await c.post('/files/init', { purpose: 'MESSAGE_ATTACHMENT', name: 'x', size: 11 * 1024 * 1024, mime: 'image/jpeg' })).status, 413);
    assert.equal((await c.post('/files/init', { purpose: 'MESSAGE_ATTACHMENT', name: 'x', size: 51 * 1024 * 1024, mime: 'application/pdf' })).status, 413);
    assert.equal((await c.post('/files/init', { purpose: 'MESSAGE_ATTACHMENT', name: 'x', size: 0, mime: 'image/jpeg' })).status, 400);
    assert.equal((await c.post('/files/init', { purpose: 'HACK', name: 'x', size: 10, mime: 'image/jpeg' })).status, 400);
    assert.equal((await c.post('/files/init', { purpose: 'CREDENTIAL', name: 'x', size: 10, mime: 'application/pdf' })).status, 403);
    assert.equal((await c.post('/files/init', { purpose: 'AVATAR', name: 'x', size: 10, mime: 'application/pdf' })).status, 400);
    // yuklab olish nomidagi xavfli belgilar tozalanadi
    const ok = await c.post('/files/init', { purpose: 'MESSAGE_ATTACHMENT', name: '../../etc/pa"ss<>.pdf', size: 100, mime: 'application/pdf' });
    assert.equal(ok.status, 201);
    const row = await t.prisma.storedFile.findUniqueOrThrow({ where: { id: ok.body.fileId } });
    assert.ok(!/[\/\\"<>]/.test(row.originalName), row.originalName);
  });

  it('photo: re-encoded, EXIF/GPS stripped, orientation applied, thumbnail created, served as attachment', async () => {
    const u = await makeUser(t);
    const jpeg = await makeJpeg(64, 32, true);
    const before = await sharp(jpeg).metadata();
    assert.ok(before.exif, 'fixture must contain EXIF');
    assert.ok(jpeg.includes(Buffer.from('SECRET-OWNER-NAME')));
    const { complete, fileId } = await uploadFile(t, u, { mime: 'image/jpeg', bytes: jpeg, name: 'photo.jpg' });
    assert.equal(complete.status, 200, JSON.stringify(complete.body));
    assert.equal(complete.body.status, 'READY');
    assert.equal(complete.body.hasThumb, true);
    assert.equal(complete.body.width, 32, 'orientation 6 swaps width/height'); // 64x32 aylantirilgan => 32x64
    assert.equal(complete.body.height, 64);

    const url = (await api(t, u.token).post('/files/' + fileId + '/download-url', { variant: 'original' })).body.url as string;
    const res = await fetch(t.baseUrl + url);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition')!, /^attachment;/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy')!, /sandbox/);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.match(res.headers.get('cache-control')!, /no-store/);
    const out = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(out).metadata();
    assert.equal(meta.exif, undefined, 'no EXIF');
    assert.equal(meta.xmp, undefined);
    assert.ok(!out.includes(Buffer.from('SECRET-OWNER-NAME')));
    assert.ok(!out.includes(Buffer.from('GPS')));

    const th = await fetch(t.baseUrl + (await api(t, u.token).post('/files/' + fileId + '/download-url', { variant: 'thumb' })).body.url);
    assert.equal(th.status, 200);
    assert.equal(th.headers.get('content-type'), 'image/webp');
    assert.ok((await sharp(Buffer.from(await th.arrayBuffer())).metadata()).width! <= 320);
  });

  it('content spoofing is rejected and wiped: HTML/SVG/EXE disguised as images, wrong declared mime', async () => {
    const u = await makeUser(t);
    const cases: [string, Buffer][] = [
      ['image/png', Buffer.from('<!doctype html><script>alert(1)</script>' + ' '.repeat(50))],
      ['image/png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>' + ' '.repeat(50))],
      ['image/jpeg', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300)])],
      ['application/pdf', Buffer.from('<html><body>not a pdf</body></html>' + ' '.repeat(50))],
      ['image/png', await makeJpeg(16, 16, false)], // JPEG, PNG deb e'lon qilingan
    ];
    for (const [mime, bytes] of cases) {
      const r = await uploadFile(t, u, { mime, bytes });
      assert.equal(r.complete.status, 422, mime);
      const row = await t.prisma.storedFile.findUniqueOrThrow({ where: { id: r.fileId } });
      assert.equal(row.status, 'REJECTED');
      assert.ok(row.deletedAt);
      assert.equal((await api(t, u.token).post('/files/' + r.fileId + '/download-url', {})).status, 404);
    }
  });

  it('a truncated/corrupt image that has valid magic bytes is rejected', async () => {
    const u = await makeUser(t);
    const jpeg = await makeJpeg(200, 200, false);
    const r = await uploadFile(t, u, { mime: 'image/jpeg', bytes: jpeg.subarray(0, Math.floor(jpeg.length / 3)) });
    assert.equal(r.complete.status, 422);
    assert.equal(r.complete.body.code, 'IMAGE_UNREADABLE');
  });

  it('PDF: accepted when clean; active content and truncation rejected', async () => {
    const u = await makeUser(t);
    const ok = await uploadFile(t, u, { mime: 'application/pdf', bytes: makePdf() });
    assert.equal(ok.complete.status, 200);
    assert.equal(ok.complete.body.pageCount, 1);
    assert.equal(ok.complete.body.hasThumb, false, 'PDF first-page preview is NOT implemented (KNOWN_GAPS)');
    const js = await uploadFile(t, u, { mime: 'application/pdf', bytes: makePdf({ extra: '4 0 obj<</S/JavaScript/JS(app.alert(1))>>endobj\n' }) });
    assert.equal(js.complete.status, 422);
    assert.equal(js.complete.body.code, 'PDF_ACTIVE_CONTENT');
  });

  it('large PDF is chunked and resumable: missing chunks block completion; resume returns only what is missing', async () => {
    const u = await makeUser(t);
    const pdf = makePdf({ padTo: Math.floor(2.5 * CHUNK) });
    const first = await uploadFile(t, u, { mime: 'application/pdf', bytes: pdf, skip: [1] });
    assert.equal(first.init.body.chunkCount, 3);
    assert.equal(first.complete.status, 409);
    assert.deepEqual(first.complete.body.missing, [1]);
    const resume = await api(t, u.token).post('/files/' + first.fileId + '/resume');
    assert.deepEqual(resume.body.received, [0, 2]);
    assert.equal(resume.body.parts.length, 1);
    const put = await fetch(t.baseUrl + resume.body.parts[0].url, { method: 'PUT', body: pdf.subarray(CHUNK, 2 * CHUNK) as any });
    assert.equal(put.status, 200);
    // takroriy yuborish xavfsiz (idempotent)
    assert.equal((await fetch(t.baseUrl + resume.body.parts[0].url, { method: 'PUT', body: pdf.subarray(CHUNK, 2 * CHUNK) as any })).status, 200);
    const done = await api(t, u.token).post('/files/' + first.fileId + '/complete');
    assert.equal(done.status, 200);
    assert.equal(done.body.sizeBytes, pdf.length);
  });

  it('chunk endpoint: wrong size, bad index, forged/expired/foreign signatures', async () => {
    const u = await makeUser(t);
    const other = await makeUser(t);
    const pdf = makePdf({ padTo: Math.floor(1.5 * CHUNK) });
    const r = await uploadFile(t, u, { mime: 'application/pdf', bytes: pdf, noComplete: true, skip: [0, 1] });
    const part0 = r.init.body.parts[0].url as string;
    assert.equal((await fetch(t.baseUrl + part0, { method: 'PUT', body: Buffer.alloc(10) as any })).status, 400, 'wrong size');
    assert.equal((await fetch(t.baseUrl + part0 + 'x', { method: 'PUT', body: pdf.subarray(0, CHUNK) as any })).status, 403, 'forged signature');
    assert.equal((await fetch(t.baseUrl + part0.replace(/uid=[^&]+/, 'uid=' + other.id), { method: 'PUT', body: pdf.subarray(0, CHUNK) as any })).status, 403, 'other user');
    const idx2 = part0.replace('/0?', '/5?');
    assert.equal((await fetch(t.baseUrl + idx2, { method: 'PUT', body: pdf.subarray(0, CHUNK) as any })).status, 403, 'signature is bound to the index');
    clock.set(new Date(NOW.getTime() + 5 * 3_600_000)); // 4 soatlik URL muddati o'tdi
    assert.equal((await fetch(t.baseUrl + part0, { method: 'PUT', body: pdf.subarray(0, CHUNK) as any })).status, 403, 'expired');
    clock.set(NOW);
    assert.equal((await fetch(t.baseUrl + part0, { method: 'PUT', body: pdf.subarray(0, CHUNK) as any })).status, 200);
    // boshqa foydalanuvchi bu yuklashni davom ettira/yakunlay/bekor qila olmaydi
    assert.equal((await api(t, other.token).post('/files/' + r.fileId + '/complete')).status, 404);
    assert.equal((await api(t, other.token).post('/files/' + r.fileId + '/resume')).status, 404);
    assert.equal((await api(t, other.token).post('/files/' + r.fileId + '/cancel')).status, 404);
    assert.equal((await api(t, other.token).get('/files/' + r.fileId)).status, 404);
  });

  it('cancel removes the data; stale pending uploads are swept and free the quota', async () => {
    const u = await makeUser(t);
    const r = await uploadFile(t, u, { mime: 'application/pdf', bytes: makePdf({ padTo: 2 * CHUNK }), noComplete: true });
    assert.ok((await api(t, u.token).get('/files/quota')).body.usedBytes >= 2 * CHUNK);
    assert.equal((await api(t, u.token).post('/files/' + r.fileId + '/cancel')).status, 200);
    assert.equal((await api(t, u.token).get('/files/quota')).body.usedBytes, 0);
    const r2 = await uploadFile(t, u, { mime: 'application/pdf', bytes: makePdf({ padTo: 2 * CHUNK }), noComplete: true });
    clock.set(new Date(NOW.getTime() + 25 * 3_600_000));
    await api(t, u.token).post('/files/init', { purpose: 'AVATAR', name: 'a', size: 10, mime: 'image/png' }); // init tozalashni ishga tushiradi
    assert.equal((await t.prisma.storedFile.findUniqueOrThrow({ where: { id: r2.fileId } })).status, 'REJECTED');
    clock.set(NOW);
  });

  it('per-user quota is enforced and deleting frees space', async () => {
    process.env.FILE_USER_QUOTA_BYTES = String(150_000);
    try {
      const u = await makeUser(t);
      const a = await uploadFile(t, u, { mime: 'application/pdf', bytes: makePdf({ padTo: 100_000 }) });
      assert.equal(a.complete.status, 200);
      const b = await api(t, u.token).post('/files/init', { purpose: 'MESSAGE_ATTACHMENT', name: 'b.pdf', size: 100_000, mime: 'application/pdf' });
      assert.equal(b.status, 413);
      assert.equal(b.body.code, 'QUOTA_EXCEEDED');
      assert.equal((await api(t, u.token).del('/files/' + a.fileId)).status, 200);
      assert.equal((await api(t, u.token).post('/files/init', { purpose: 'MESSAGE_ATTACHMENT', name: 'b.pdf', size: 100_000, mime: 'application/pdf' })).status, 201);
    } finally {
      delete process.env.FILE_USER_QUOTA_BYTES;
    }
  });

  it('malware-scan hook: infected => quarantined and wiped; scan required + no scanner => quarantined (fail closed)', async () => {
    const scanner: any = t.app.get(SCAN_PROVIDER);
    const original = scanner.scan;
    scanner.scan = async (b: Buffer) => (b.includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')) ? { status: 'INFECTED', signature: 'Eicar-Test' } : { status: 'CLEAN' });
    try {
      const u = await makeUser(t);
      const bad = await uploadFile(t, u, { mime: 'application/pdf', bytes: makePdf({ extra: '%EICAR-STANDARD-ANTIVIRUS-TEST-FILE\n' }) });
      assert.equal(bad.complete.status, 422);
      assert.equal(bad.complete.body.code, 'MALWARE_DETECTED');
      const row = await t.prisma.storedFile.findUniqueOrThrow({ where: { id: bad.fileId } });
      assert.equal(row.status, 'QUARANTINED');
      assert.equal(row.scanStatus, 'INFECTED');
      const good = await uploadFile(t, u, { mime: 'application/pdf', bytes: makePdf() });
      assert.equal(good.complete.body.scanStatus, 'CLEAN');
    } finally {
      scanner.scan = original;
    }
    process.env.FILE_SCAN_REQUIRED = 'true';
    try {
      const u = await makeUser(t);
      const r = await uploadFile(t, u, { mime: 'application/pdf', bytes: makePdf() });
      assert.equal(r.complete.status, 422);
      assert.equal(r.complete.body.code, 'SCAN_UNAVAILABLE');
    } finally {
      delete process.env.FILE_SCAN_REQUIRED;
    }
    // skaner sozlanmagan, talab qilinmasa: fayl o'tadi, lekin NOT_SCANNED deb belgilanadi (halol holat)
    const u2 = await makeUser(t);
    const r2 = await uploadFile(t, u2, { mime: 'application/pdf', bytes: makePdf() });
    assert.equal(r2.complete.body.scanStatus, 'NOT_SCANNED');
  });

  it('any file type: a teacher uploads a big zip/html/video as class material; it is streamed back with Range and never shown inline', async () => {
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const bytes = Buffer.alloc(2.5 * CHUNK + 123);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 255;
    for (const [mime, name] of [['application/zip', 'course.zip'], ['text/html', 'lesson.html'], ['video/mp4', 'week1.mp4']]) {
      const up = await uploadFile(t, x.user, { purpose: 'CLASS_FILE', name, mime, bytes });
      assert.equal(up.complete.status, 200, JSON.stringify(up.complete.body));
      assert.equal(up.complete.body.status, 'READY');
      const url = (await api(t, x.user.token).post('/files/' + up.fileId + '/download-url', {})).body.url as string;
      const full = await fetch(t.baseUrl + url);
      assert.equal(full.status, 200);
      assert.match(full.headers.get('content-disposition') ?? '', /^attachment/);
      assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
      assert.match(full.headers.get('content-security-policy') ?? '', /sandbox/);
      assert.ok(Buffer.from(await full.arrayBuffer()).equals(bytes), 'bytes are identical');
      const part = await fetch(t.baseUrl + url, { headers: { range: 'bytes=1000-1999' } });
      assert.equal(part.status, 206);
      assert.equal(part.headers.get('content-range'), `bytes 1000-1999/${bytes.length}`);
      assert.ok(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(1000, 2000)));
    }
    const kid = await makeUser(t);
    assert.equal((await api(t, kid.token).post('/files/init', { purpose: 'CLASS_FILE', name: 'a.zip', size: 10, mime: 'application/zip' })).status, 400, 'class material is for teachers');
    assert.equal((await api(t, kid.token).post('/files/init', { purpose: 'AVATAR', name: 'a.zip', size: 10, mime: 'application/zip' })).status, 400, 'a profile photo must be an image');
    const huge = await api(t, x.user.token).post('/files/init', { purpose: 'CLASS_FILE', name: 'big.mkv', size: 101 * 1024 * 1024 * 1024, mime: 'video/x-matroska' });
    assert.equal(huge.status, 413);
  });

  it('download authorization: owner yes; stranger 404; signed URL bound to user, variant and time', async () => {
    const owner = await makeUser(t);
    const stranger = await makeUser(t);
    const f = await uploadFile(t, owner, { mime: 'application/pdf', bytes: makePdf() });
    assert.equal((await api(t, stranger.token).post('/files/' + f.fileId + '/download-url', {})).status, 404);
    const url = (await api(t, owner.token).post('/files/' + f.fileId + '/download-url', {})).body.url as string;
    assert.equal((await fetch(t.baseUrl + url)).status, 200);
    assert.equal((await fetch(t.baseUrl + url.replace(/uid=[^&]+/, 'uid=' + stranger.id))).status, 403, 'URL is useless for another user id');
    assert.equal((await fetch(t.baseUrl + url.replace('/original?', '/thumb?'))).status, 403);
    assert.equal((await fetch(t.baseUrl + url.replace(/sig=.*/, 'sig=AAAA'))).status, 403);
    clock.set(new Date(NOW.getTime() + 3 * 60_000)); // 120 s TTL o'tdi
    assert.equal((await fetch(t.baseUrl + url)).status, 403, 'expired');
    clock.set(NOW);
    // egasi bloklansa/o'chirilsa havola ishlamaydi
    await t.prisma.user.update({ where: { id: owner.id }, data: { status: 'SUSPENDED' } });
    assert.equal((await fetch(t.baseUrl + url)).status, 403);
    // PDF uchun eskiz yo'q
    const owner2 = await makeUser(t);
    const f2 = await uploadFile(t, owner2, { mime: 'application/pdf', bytes: makePdf() });
    assert.equal((await api(t, owner2.token).post('/files/' + f2.fileId + '/download-url', { variant: 'thumb' })).status, 404);
  });

  it('credential files: only the owner and an admin reviewer (audited) can download', async () => {
    const tch = await makeTeacher(t);
    const other = await makeTeacher(t);
    const f = await uploadFile(t, tch.user, { mime: 'application/pdf', bytes: makePdf(), purpose: 'CREDENTIAL' });
    assert.equal(f.complete.status, 200);
    assert.equal((await api(t, other.user.token).post('/files/' + f.fileId + '/download-url', {})).status, 404);
    const adminUrl = await api(t, admin.token).post('/admin/market/files/' + f.fileId + '/download-url');
    assert.equal(adminUrl.status, 200);
    assert.equal((await fetch(t.baseUrl + adminUrl.body.url)).status, 200);
    assert.equal(await t.prisma.auditLog.count({ where: { action: 'file.admin_download', targetId: f.fileId } }), 1);
    // admin boshqa maqsaddagi (xabar ilovasi) faylni shu yo'l bilan ocholmaydi
    const pupil = await makeUser(t);
    const att = await uploadFile(t, pupil, { mime: 'application/pdf', bytes: makePdf() });
    assert.equal((await api(t, admin.token).post('/admin/market/files/' + att.fileId + '/download-url')).status, 404);
    // a credential can be attached to the teacher profile
    const c = await api(t, tch.user.token).post('/teachers/me/credentials', { kind: 'DEGREE', title: 'Diploma', fileId: f.fileId });
    assert.equal(c.status, 201);
    assert.equal((await api(t, tch.user.token).del('/files/' + f.fileId)).status, 409, 'attached credential cannot be deleted');
  });

  it('path-like file ids and unknown variants never reach the storage layer', async () => {
    const u = await makeUser(t);
    assert.equal((await api(t, u.token).get('/files/..%2F..%2Fetc%2Fpasswd')).status, 400);
    const f = await uploadFile(t, u, { mime: 'application/pdf', bytes: makePdf() });
    const url = (await api(t, u.token).post('/files/' + f.fileId + '/download-url', {})).body.url as string;
    assert.equal((await fetch(t.baseUrl + url.replace('/original?', '/..%2Foriginal?'))).status, 403);
  });

  it('a download link whose bytes are gone answers 404, never 500', async () => {
    const u = await makeUser(t);
    const f = await uploadFile(t, u, { mime: 'application/pdf', bytes: makePdf() });
    const row = await t.prisma.storedFile.findUniqueOrThrow({ where: { id: f.fileId } });
    const url = (await api(t, u.token).post('/files/' + f.fileId + '/download-url', {})).body.url as string;
    await (t.app.get(OBJECT_STORAGE) as any).deletePrefix(row.storageKey);
    assert.equal((await fetch(t.baseUrl + url)).status, 404);
  });
});
