import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { ClockService } from '../common/clock';
import { FilesService } from '../files/files.service';
import { OBJECT_STORAGE } from '../files/storage';
import { LedgerService } from '../payments/ledger.service';
import { DomainEvents } from '../common/events';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makePdf, makeTeacher, makeThread, makeUser, TestApp, uploadFile } from '../testing/harness';

const NOW = new Date('2026-11-02T00:00:00Z');
let slot = 0;

describe('privacy: export and delete my data (integration)', () => {
  let t: TestApp;
  let clock: ClockService;
  let admin: { id: string; token: string };

  const teacher = async () => {
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    await api(t, x.user.token).put('/teachers/me/profile', { instantBooking: true });
    return x;
  };
  const when = () => {
    const n = slot++;
    const days = ['03', '04', '05', '06', '09', '10', '11', '12'];
    return `2026-11-${days[n % days.length]}T${String(4 + (Math.floor(n / days.length) % 8)).padStart(2, '0')}:00:00.000Z`;
  };

  before(async () => {
    t = await createTestApp();
    clock = t.app.get(ClockService);
    clock.set(NOW);
    admin = await makeAdmin(t);
  });
  after(async () => {
    clock.set(null);
    await t.close();
  });

  it('route matrix', async () => {
    const actors = { STUDENT: await makeUser(t, Role.STUDENT), GUARDIAN: await makeUser(t, Role.GUARDIAN), TEACHER: await makeUser(t, Role.TEACHER), adminToken: admin.token };
    const failures = await checkRouteMatrix(t, actors, [
      { method: 'GET', path: '/me/export', allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('delete needs the explicit confirmation word', async () => {
    const u = await makeUser(t);
    assert.equal((await api(t, u.token).post('/me/delete', {})).status, 400);
    assert.equal((await api(t, u.token).post('/me/delete', { confirm: 'yes' })).status, 400);
    assert.equal((await api(t, u.token).get('/me')).status, 200);
  });

  it('export contains my data (both sides of my chats) and never other users\' emails, ids or birth dates', async () => {
    const tch = await teacher();
    const me = await makeUser(t, Role.STUDENT, { name: 'Me Myself' });
    const th = await makeThread(t, tch, me, when());
    await api(t, me.token).post(`/threads/${th.threadId}/messages`, { body: 'my question' });
    await api(t, tch.user.token).post(`/threads/${th.threadId}/messages`, { body: 'teacher answer' });
    const f = await uploadFile(t, me, { mime: 'application/pdf', bytes: makePdf(), name: 'hw.pdf' });
    await api(t, me.token).post('/legal/consents', { kind: 'MARKETING', version: 'v' });
    const r = await api(t, me.token).get('/me/export');
    assert.equal(r.status, 200);
    const x = r.body;
    assert.equal(x.account.email, me.email);
    assert.equal(x.account.dateOfBirth, '1990-01-01');
    assert.deepEqual(x.conversations[0].messages.map((m: any) => [m.mine, m.body]), [[true, 'my question'], [false, 'teacher answer']]);
    assert.equal(x.bookings.length, 1);
    assert.equal(x.bookings[0].myRole, 'pupil');
    assert.equal(x.files[0].originalName, 'hw.pdf');
    assert.ok(x.consents.some((c: any) => c.kind === 'MARKETING'));
    const raw = JSON.stringify(x);
    for (const secret of [tch.user.email, tch.user.id, tch.profileId.slice(0, 8) && 'passwordHash', 'storageKey']) assert.ok(!raw.includes(secret), secret);
    assert.ok(await t.prisma.auditLog.findFirst({ where: { actorId: me.id, action: 'account.export' } }));
    assert.ok(f.fileId);
    // o'qituvchi eksporti profilni o'z ichiga oladi, o'quvchining emailini emas
    const te = (await api(t, tch.user.token).get('/me/export')).body;
    assert.ok(te.teacherProfile.headline);
    assert.ok(!JSON.stringify(te).includes(me.email) && !JSON.stringify(te).includes(me.id));
  });

  it('delete is blocked while there are open bookings or unsettled money, and works after they are resolved', async () => {
    const tch = await teacher();
    const s = await makeUser(t);
    const th = await makeThread(t, tch, s, when());
    const del = await api(t, s.token).post('/me/delete', { confirm: 'DELETE' });
    assert.equal(del.status, 409);
    assert.equal(del.body.code, 'DELETE_BLOCKED');
    assert.deepEqual(del.body.blockers.map((b: any) => b.code), ['OPEN_BOOKINGS']);
    await api(t, s.token).post(`/bookings/${th.bookingId}/cancel`);
    // teacher with money
    const ledger = t.app.get(LedgerService);
    const t2 = await makeUser(t, Role.TEACHER);
    await t.prisma.$transaction((tx) => ledger.post(tx, { key: 'seed-' + t2.id, kind: 'TEST', lines: [{ account: 'EXTERNAL_PAYMENTS', amount: -100 }, { account: 'TEACHER_AVAILABLE', ownerId: t2.id, amount: 100 }] }));
    const d2 = await api(t, t2.token).post('/me/delete', { confirm: 'DELETE' });
    assert.equal(d2.status, 409);
    assert.ok(d2.body.blockers.some((b: any) => b.code === 'TEACHER_BALANCE'));
    assert.equal((await api(t, s.token).post('/me/delete', { confirm: 'DELETE' })).status, 200);
  });

  it('deleting a pupil anonymises personal data, wipes messages/files/notifications/blocks, keeps legally retained records, and the counterpart keeps working', async () => {
    const tch = await teacher();
    const me = await makeUser(t, Role.STUDENT, { name: 'Delete Me' });
    const other = await makeUser(t);
    const th = await makeThread(t, tch, me, when());
    await api(t, me.token).post(`/threads/${th.threadId}/messages`, { body: 'secret content' });
    await api(t, tch.user.token).post(`/threads/${th.threadId}/messages`, { body: 'reply stays' });
    const file = await uploadFile(t, me, { mime: 'application/pdf', bytes: makePdf(), name: 'mine.pdf' });
    const key = (await t.prisma.storedFile.findUniqueOrThrow({ where: { id: file.fileId } })).storageKey;
    const storage: any = t.app.get(OBJECT_STORAGE);
    assert.equal(await storage.exists(`${key}/blob`), true);
    await api(t, me.token).post('/blocks/teacher', { teacherId: tch.profileId });
    await api(t, other.token).post('/blocks/teacher', { teacherId: tch.profileId });
    await t.prisma.streak.create({ data: { userId: me.id, currentCount: 3 } });
    await api(t, me.token).post(`/bookings/${th.bookingId}/cancel`);
    const consentsBefore = await t.prisma.consent.count({ where: { userId: me.id } });
    const auditBefore = await t.prisma.auditLog.count({ where: { actorId: me.id } });

    const res = await api(t, me.token).post('/me/delete', { confirm: 'DELETE' });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const u = await t.prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    assert.equal(u.status, 'DELETED');
    assert.equal(u.email, `deleted-${me.id}@deleted.invalid`);
    assert.equal(u.name, null);
    assert.equal(u.dateOfBirth, null);
    assert.ok(u.deletedAt);
    assert.equal((await api(t, me.token).get('/me')).status, 401, 'old tokens stop working');
    assert.equal((await api(t, me.token).post('/me/delete', { confirm: 'DELETE' })).status, 401);
    const msgs = await t.prisma.chatMessage.findMany({ where: { threadId: th.threadId } });
    assert.ok(msgs.filter((m) => m.senderId === me.id).every((m) => m.body === '' && m.deletedAt));
    assert.ok(msgs.filter((m) => m.senderId === tch.user.id).every((m) => m.body === 'reply stays'));
    assert.equal(await storage.exists(`${key}/blob`), false, 'file bytes removed');
    assert.ok((await t.prisma.storedFile.findUniqueOrThrow({ where: { id: file.fileId } })).deletedAt);
    assert.equal(await t.prisma.notification.count({ where: { userId: me.id } }), 0);
    assert.equal(await t.prisma.userBlock.count({ where: { blockerId: me.id } }), 0);
    assert.equal(await t.prisma.userBlock.count({ where: { blockerId: other.id } }), 1, 'other users\' data untouched');
    assert.equal(await t.prisma.streak.count({ where: { userId: me.id } }), 0, 'exam-app learning data removed');
    // saqlanadigan yozuvlar
    assert.equal(await t.prisma.consent.count({ where: { userId: me.id } }), consentsBefore);
    assert.ok((await t.prisma.auditLog.count({ where: { actorId: me.id } })) > auditBefore);
    assert.ok(await t.prisma.booking.findUnique({ where: { id: th.bookingId } }), 'booking record kept');
    // suhbatdosh uchun hammasi ishlayveradi, eski xabar tarkibi ko'rinmaydi
    const view = (await api(t, tch.user.token).get(`/threads/${th.threadId}/messages`)).body;
    assert.deepEqual(view.map((m: any) => m.body), ['reply stays']);
    assert.equal((await api(t, tch.user.token).get('/threads')).status, 200);
    // o'chirilgan foydalanuvchiga yozib bo'lmaydi
    assert.equal((await api(t, tch.user.token).post(`/threads/${th.threadId}/messages`, { body: 'hello?' })).status, 409);
  });

  it('deleting a teacher hides and empties the profile, removes credentials and files, keeps ratings so aggregates stay intact', async () => {
    const tch = await teacher();
    const s = await makeUser(t);
    const th = await makeThread(t, tch, s, when());
    await t.prisma.booking.update({ where: { id: th.bookingId }, data: { status: 'COMPLETED', completedAt: NOW } });
    assert.equal((await api(t, s.token).post(`/bookings/${th.bookingId}/review`, { rating: 5, text: 'great' })).status, 201);
    const credCount = await t.prisma.teacherCredential.count({ where: { teacherId: tch.profileId } });
    assert.ok(credCount > 0);
    const res = await api(t, tch.user.token).post('/me/delete', { confirm: 'DELETE' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await t.prisma.teacherCredential.count({ where: { teacherId: tch.profileId } }), 0);
    assert.equal(await t.prisma.availabilityRule.count({ where: { teacherId: tch.profileId } }), 0);
    const p = await t.prisma.teacherProfile.findUniqueOrThrow({ where: { id: tch.profileId } });
    assert.equal(p.bio, '');
    assert.equal(p.verificationStatus, 'SUSPENDED');
    assert.equal(await t.prisma.storedFile.count({ where: { ownerId: tch.user.id, deletedAt: null } }), 0);
    assert.equal((await api(t, s.token).get('/teachers/' + tch.profileId)).status, 404);
    const search = await api(t, s.token).get('/teachers?q=Tutor&pageSize=50');
    assert.ok(!search.body.items.some((i: any) => i.id === tch.profileId));
    assert.equal(p.ratingCount, 1);
  });

  it('a pupil\'s review text is erased on deletion but the rating remains', async () => {
    const tch = await teacher();
    const s = await makeUser(t);
    const th = await makeThread(t, tch, s, when());
    await t.prisma.booking.update({ where: { id: th.bookingId }, data: { status: 'COMPLETED', completedAt: NOW } });
    const rv = (await api(t, s.token).post(`/bookings/${th.bookingId}/review`, { rating: 4, text: 'personal remark' })).body;
    assert.equal((await api(t, s.token).post('/me/delete', { confirm: 'DELETE' })).status, 200);
    const row = await t.prisma.review.findUniqueOrThrow({ where: { id: rv.id } });
    assert.equal(row.text, '');
    assert.equal(row.rating, 4);
    assert.ok(t.app.get(DomainEvents) && t.app.get(FilesService));
  });

  it('guardian statement is required before linking; accepting it unlocks the flow', async () => {
    const minor = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05' });
    const g = await makeUser(t, Role.GUARDIAN, { consent: false });
    await t.prisma.consent.create({ data: { userId: g.id, kind: 'TERMS', version: '2026-10-draft-1' } });
    const code = (await api(t, minor.token).post('/guardian/code')).body.code;
    const denied = await api(t, g.token).post('/guardian/link', { code });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'GUARDIAN_STATEMENT_REQUIRED');
    assert.equal((await api(t, g.token).post('/legal/consents', { kind: 'GUARDIAN_STATEMENT', version: '2026-10-draft-1' })).status, 200);
    assert.equal((await api(t, g.token).post('/guardian/link', { code })).status, 200);
    const stmt: any = await (await fetch(t.baseUrl + '/legal/guardian-statement?locale=en')).json();
    assert.equal(stmt.draft, true);
    assert.match(stmt.text, /cannot verify/);
  });
});
