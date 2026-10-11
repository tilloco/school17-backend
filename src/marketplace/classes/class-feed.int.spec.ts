import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { ClockService } from '../common/clock';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makeJpeg, makePdf, makeTeacher, makeUser, TestApp, TestUser, uploadFile } from '../testing/harness';
import { ClassFilesService } from './class-files.service';
import { ClassRemindersService } from './class-reminders.service';
import { ClassRoomService, classRoomName } from './class-room.service';

const START = '2026-11-05T10:00:00.000Z';
const at = (m: number) => new Date(new Date(START).getTime() + m * 60_000);
const ev = (type: 'participant_joined' | 'participant_left', sid: string, identity: string, when: Date) => ({ type, roomName: classRoomName(sid), identity, at: when });

describe('class recap, notes, homework, reminders (R8, integration)', () => {
  let t: TestApp;
  let clock: ClockService;
  let room: ClassRoomService;
  let admin: { id: string; token: string };

  async function klass(n = 3, opts: { minor?: boolean; oneOff?: boolean } = {}) {
    clock.set(new Date('2026-11-02T00:00:00Z'));
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const body: any = { title: 'Math', subject: 'Math', capacity: 30 };
    if (opts.oneOff === false) Object.assign(body, { weekdays: [1, 3], startMinute: 18 * 60 });
    else body.oneOffStartAt = START;
    const c = (await api(t, x.user.token).post('/classes', body)).body;
    const ps: TestUser[] = [];
    for (let i = 0; i < n; i++) {
      const u = await makeUser(t, Role.STUDENT, { name: `Pupil${i} Family${i}` });
      await api(t, u.token).post('/classes/join', { code: c.joinCode });
      ps.push(u);
    }
    let minor: TestUser | undefined;
    let guardian: TestUser | undefined;
    if (opts.minor) {
      guardian = await makeUser(t, Role.GUARDIAN);
      minor = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05', name: 'Aziz Karimov' });
      await t.prisma.guardianLink.create({ data: { guardianId: guardian.id, studentId: minor.id, status: 'ACTIVE' } });
      await api(t, guardian.token).post('/classes/join', { code: c.joinCode, studentId: minor.id });
    }
    const sid = (await api(t, x.user.token).get(`/classes/${c.id}/sessions`)).body[0].id as string;
    return { x, c, ps, sid, minor, guardian };
  }
  /** Sessiyani o'tkazadi: start -> kirish/chiqish -> savollar -> tugatish */
  async function runClass(k: Awaited<ReturnType<typeof klass>>) {
    clock.set(at(-5));
    await api(t, k.x.user.token).post(`/class-sessions/${k.sid}/start`);
    clock.set(at(1));
    await room.handleEvents([ev('participant_joined', k.sid, k.ps[0].id, at(1)), ev('participant_joined', k.sid, k.ps[1].id, at(9))]);
    const q = (u: TestUser, text: string, anon = false) => api(t, u.token).post(`/class-sessions/${k.sid}/questions`, { text, anonymous: anon });
    const q1 = (await q(k.ps[0], 'What is a limit?')).body;
    const q2 = (await q(k.ps[1], 'Why is 0.999 equal to 1?', true)).body;
    const q3 = (await q(k.ps[1], 'Is this on the exam?')).body;
    const q4 = (await q(k.ps[0], 'spammy question')).body;
    await api(t, k.x.user.token).post(`/class-sessions/${k.sid}/questions/${q1.id}/answer`, { reply: 'A limit is the value a function approaches.' });
    await api(t, k.x.user.token).post(`/class-sessions/${k.sid}/questions/${q4.id}/hide`);
    clock.set(at(40));
    await room.handleEvents([ev('participant_left', k.sid, k.ps[0].id, at(40))]);
    await api(t, k.x.user.token).post(`/class-sessions/${k.sid}/end`);
    return { q1, q2, q3, q4 };
  }

  before(async () => {
    t = await createTestApp();
    clock = t.app.get(ClockService);
    room = t.app.get(ClassRoomService);
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
      { method: 'GET', path: `/classes/${id}/feed`, allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'GET', path: `/class-sessions/${id}/recap`, allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'PUT', path: `/class-sessions/${id}/note`, body: { topic: 'x' }, allowed: ['TEACHER'] },
      { method: 'POST', path: `/class-sessions/${id}/questions/${id}/late-answer`, body: { text: 'x' }, allowed: ['TEACHER'] },
      { method: 'GET', path: `/classes/${id}/attendance/mine`, allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'POST', path: `/classes/${id}/homework`, body: { title: 'x', dueAt: '2030-01-01T00:00:00Z' }, allowed: ['TEACHER'] },
      { method: 'GET', path: `/classes/${id}/homework`, allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'GET', path: `/classes/${id}/homework/${id}`, allowed: ['TEACHER', 'STUDENT', 'GUARDIAN'] },
      { method: 'POST', path: `/classes/${id}/homework/${id}/submit`, body: { text: 'x' }, allowed: ['STUDENT', 'GUARDIAN'] },
      { method: 'POST', path: `/classes/${id}/homework/${id}/submissions/${id}/mark`, body: { score: 5 }, allowed: ['TEACHER'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('recap: built when the class ends; the teacher sees everything, a pupil only his own attendance and answered Q&A; guardians see their child; outsiders nothing', async () => {
    const k = await klass(3, { minor: true });
    const files = t.app.get(ClassFilesService);
    // ko'rsatilgan fayl
    const up = await uploadFile(t, k.x.user, { name: 'book.pdf', mime: 'application/pdf', bytes: makePdf(), purpose: 'CLASS_FILE' });
    const cf = (await api(t, k.x.user.token).post(`/classes/${k.c.id}/files`, { fileId: up.fileId })).body;
    await files.drain();
    clock.set(at(-5));
    await api(t, k.x.user.token).post(`/class-sessions/${k.sid}/start`);
    await api(t, k.x.user.token).post(`/class-sessions/${k.sid}/present`, { fileId: cf.id, page: 1 });
    await api(t, k.x.user.token).post(`/class-sessions/${k.sid}/end`);
    // yuqoridagi tugatish bilan alohida sinf: to'liq oqim
    const k2 = await klass(3, { minor: true });
    const qs = await runClass(k2);
    const r = (await api(t, k2.x.user.token).get(`/class-sessions/${k2.sid}/recap`)).body;
    assert.equal(r.role, 'teacher');
    assert.equal(r.attendance.length, 4);
    const a0 = r.attendance.find((a: any) => a.pupilId === k2.ps[0].id);
    assert.equal(a0.attended, true);
    assert.equal(a0.totalSeconds, 39 * 60);
    assert.equal(r.attendance.find((a: any) => a.pupilId === k2.ps[1].id).joinedLate, true);
    assert.equal(r.attendance.find((a: any) => a.pupilId === k2.ps[2].id).attended, false);
    assert.equal(r.questions.asked, 3, 'hidden questions are not counted');
    assert.equal(r.questions.answered, 1);
    assert.deepEqual(r.questions.unanswered.map((q: any) => q.id).sort(), [qs.q2.id, qs.q3.id].sort());
    assert.ok(r.durationSec >= 44 * 60);
    // o'quvchi ko'rinishi
    const pr = (await api(t, k2.ps[0].token).get(`/class-sessions/${k2.sid}/recap`)).body;
    assert.equal(pr.role, 'pupil');
    assert.deepEqual(pr.attendance.map((a: any) => a.pupilId), [k2.ps[0].id]);
    assert.equal(pr.questions.answeredList.length, 1);
    assert.equal(pr.questions.unanswered, undefined, 'unanswered questions are not shown to pupils');
    const raw = JSON.stringify(pr);
    for (const s of [k2.ps[1].id, k2.ps[2].id, 'Family1', 'Why is 0.999']) assert.ok(!raw.includes(s), s);
    // vasiy: faqat o'z bolasi
    const gr = (await api(t, k2.guardian!.token).get(`/class-sessions/${k2.sid}/recap`)).body;
    assert.deepEqual(gr.attendance.map((a: any) => a.pupilId), [k2.minor!.id]);
    assert.equal(gr.attendance[0].attended, false);
    assert.equal((await api(t, (await makeUser(t)).token).get(`/class-sessions/${k2.sid}/recap`)).status, 404);
    assert.equal((await api(t, k.x.user.token).get(`/class-sessions/${k.sid}/recap`)).body.files[0].name !== undefined, true, 'presented files are listed');
    const feed = (await api(t, k2.ps[0].token).get(`/classes/${k2.c.id}/feed`)).body;
    assert.deepEqual(feed.map((p: any) => p.kind), ['RECAP']);
    assert.equal(feed[0].data, null);
    // o'qituvchi kelmagan sessiya: xulosa yo'q
    const ns = await klass(1);
    clock.set(at(16));
    await room.sweep();
    assert.equal((await api(t, ns.ps[0].token).get(`/class-sessions/${ns.sid}/recap`)).status, 404);
  });

  it('notes: only after a class that took place, teacher only, editable for 24 h, contact info blocked when minors attend; pupils and guardians read them', async () => {
    const k = await klass(2, { minor: true });
    const note = { topic: 'Limits', homework: 'Exercises 1-5', nextStep: 'Derivatives' };
    assert.equal((await api(t, k.x.user.token).put(`/class-sessions/${k.sid}/note`, note)).body.code, 'NOT_ENDED');
    await runClass(k);
    assert.equal((await api(t, k.ps[0].token).put(`/class-sessions/${k.sid}/note`, note)).status, 403);
    assert.equal((await api(t, k.x.user.token).put(`/class-sessions/${k.sid}/note`, {})).status, 400);
    assert.equal((await api(t, k.x.user.token).put(`/class-sessions/${k.sid}/note`, { topic: 'call +998 90 123 45 67' })).body.code, 'CONTACT_INFO_NOT_ALLOWED');
    const made = await api(t, k.x.user.token).put(`/class-sessions/${k.sid}/note`, note);
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const seen = (await api(t, k.ps[1].token).get(`/class-sessions/${k.sid}/recap`)).body.note;
    assert.deepEqual(seen, note);
    assert.deepEqual((await api(t, k.guardian!.token).get(`/class-sessions/${k.sid}/recap`)).body.note, note);
    clock.set(new Date(clock.now().getTime() + 23 * 3_600_000));
    assert.equal((await api(t, k.x.user.token).put(`/class-sessions/${k.sid}/note`, { ...note, nextStep: 'Integrals' })).status, 200, 'still editable inside 24 h');
    assert.equal((await api(t, k.ps[0].token).get(`/classes/${k.c.id}/feed`)).body.find((p: any) => p.kind === 'NOTE').data.nextStep, 'Integrals');
    clock.set(new Date(clock.now().getTime() + 2 * 3_600_000));
    assert.equal((await api(t, k.x.user.token).put(`/class-sessions/${k.sid}/note`, note)).body.code, 'EDIT_WINDOW_CLOSED');
    const stranger = await makeTeacher(t, { approve: { adminToken: admin.token } });
    assert.equal((await api(t, stranger.user.token).put(`/class-sessions/${k.sid}/note`, note)).status, 404);
  });

  it('late answers: the teacher answers an unanswered question into the feed without revealing who asked', async () => {
    const k = await klass(2);
    const qs = await runClass(k);
    assert.equal((await api(t, k.ps[0].token).post(`/class-sessions/${k.sid}/questions/${qs.q2.id}/late-answer`, { text: 'x' })).status, 403);
    const ok = await api(t, k.x.user.token).post(`/class-sessions/${k.sid}/questions/${qs.q2.id}/late-answer`, { text: 'Because 1/3 times 3 is 1.' });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal((await api(t, k.x.user.token).post(`/class-sessions/${k.sid}/questions/${qs.q2.id}/late-answer`, { text: 'again' })).body.code, 'ALREADY_ANSWERED');
    assert.equal((await api(t, k.x.user.token).post(`/class-sessions/${k.sid}/questions/${qs.q1.id}/late-answer`, { text: 'again' })).body.code, 'ALREADY_ANSWERED');
    const feed = (await api(t, k.ps[0].token).get(`/classes/${k.c.id}/feed`)).body;
    const post = feed.find((p: any) => p.kind === 'ANSWER');
    assert.equal(post.title, 'Why is 0.999 equal to 1?');
    assert.equal(post.text, 'Because 1/3 times 3 is 1.');
    assert.ok(!JSON.stringify(post).includes(k.ps[1].id) && !JSON.stringify(post).includes('Pupil1'), 'the anonymous asker stays anonymous');
    assert.equal((await api(t, k.x.user.token).post(`/class-sessions/${k.sid}/questions/${qs.q3.id}/late-answer`, { text: ' ' })).status, 400);
  });

  it('homework: assigned to the whole class, submitted as text or file, late flagged, marked; every cross-access is denied', async () => {
    const k = await klass(3, { minor: true });
    const other = await klass(1);
    clock.set(new Date('2026-11-02T00:00:00Z'));
    const due = '2026-11-04T00:00:00.000Z';
    assert.equal((await api(t, k.ps[0].token).post(`/classes/${k.c.id}/homework`, { title: 'HW', dueAt: due })).status, 403);
    assert.equal((await api(t, k.x.user.token).post(`/classes/${k.c.id}/homework`, { title: 'HW', dueAt: '2026-11-01T00:00:00Z' })).status, 400, 'deadline in the past');
    assert.equal((await api(t, k.x.user.token).post(`/classes/${k.c.id}/homework`, { title: 'Write to me at teacher@example.com', dueAt: due })).body.code, 'CONTACT_INFO_NOT_ALLOWED');
    assert.equal((await api(t, other.x.user.token).post(`/classes/${k.c.id}/homework`, { title: 'HW', dueAt: due })).status, 404);
    const hw = await api(t, k.x.user.token).post(`/classes/${k.c.id}/homework`, { title: 'Exercises 1-5', text: 'Do them all.', dueAt: due });
    assert.equal(hw.status, 201, JSON.stringify(hw.body));
    const hid = hw.body.id as string;
    assert.equal(await t.prisma.notification.count({ where: { userId: k.ps[0].id, type: 'class.homework' } }), 1);
    assert.equal(await t.prisma.notification.count({ where: { userId: k.guardian!.id, type: 'class.homework' } }), 1, 'guardian of a minor is told too');
    assert.equal((await api(t, k.ps[1].token).get(`/classes/${k.c.id}/feed`)).body[0].kind, 'HOMEWORK');
    // topshirish: matn
    const s0 = await api(t, k.ps[0].token).post(`/classes/${k.c.id}/homework/${hid}/submit`, { text: 'Done: 1) 4 2) 9' });
    assert.equal(s0.status, 200, JSON.stringify(s0.body));
    assert.equal(s0.body.late, false);
    assert.equal((await api(t, k.ps[0].token).post(`/classes/${k.c.id}/homework/${hid}/submit`, { text: 'Done v2' })).status, 200, 'resubmitting before it is marked');
    assert.equal((await api(t, k.ps[0].token).post(`/classes/${k.c.id}/homework/${hid}/submit`, {})).status, 400);
    assert.equal((await api(t, other.ps[0].token).post(`/classes/${k.c.id}/homework/${hid}/submit`, { text: 'x' })).status, 404, 'a pupil of another class');
    assert.equal((await api(t, k.x.user.token).post(`/classes/${k.c.id}/homework/${hid}/submit`, { text: 'x' })).status, 403);
    // fayl bilan, kech
    clock.set(new Date('2026-11-04T10:00:00Z'));
    const up = await uploadFile(t, k.ps[1], { name: 'hw.jpg', mime: 'image/jpeg', bytes: await makeJpeg(40, 40, false), purpose: 'HOMEWORK' });
    assert.equal(up.complete.status, 200, JSON.stringify(up.init.body));
    const s1 = await api(t, k.ps[1].token).post(`/classes/${k.c.id}/homework/${hid}/submit`, { fileId: up.fileId });
    assert.equal(s1.body.late, true, 'late submissions are flagged');
    assert.equal((await api(t, k.ps[2].token).post(`/classes/${k.c.id}/homework/${hid}/submit`, { fileId: up.fileId })).status, 404, "someone else's file");
    // fayl ruxsati
    const dl = (tok: string) => api(t, tok).post(`/files/${up.fileId}/download-url`, {});
    assert.equal((await dl(k.ps[1].token)).status, 200);
    assert.equal((await dl(k.x.user.token)).status, 200, 'the class teacher');
    assert.equal((await dl(k.ps[2].token)).status, 404, 'a classmate');
    assert.equal((await dl(other.x.user.token)).status, 404, 'another teacher');
    // guardian topshiradi (bola uchun)
    const g = await api(t, k.guardian!.token).post(`/classes/${k.c.id}/homework/${hid}/submit`, { text: 'Done by Aziz', studentId: k.minor!.id });
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.equal((await api(t, k.guardian!.token).post(`/classes/${k.c.id}/homework/${hid}/submit`, { text: 'x', studentId: k.ps[0].id })).status, 404, 'not his child');
    // ko'rinish
    const mineList = (await api(t, k.ps[0].token).get(`/classes/${k.c.id}/homework`)).body[0];
    assert.equal(mineList.mine.length, 1);
    assert.equal(mineList.submitted, undefined, 'pupils do not see class-wide counts');
    const full = (await api(t, k.x.user.token).get(`/classes/${k.c.id}/homework/${hid}`)).body;
    assert.equal(full.pupils.filter((p: any) => p.submission).length, 3);
    const asPupil = (await api(t, k.ps[2].token).get(`/classes/${k.c.id}/homework/${hid}`)).body;
    assert.deepEqual(asPupil.mine, [], 'a pupil never sees classmates submissions');
    assert.ok(!JSON.stringify(asPupil).includes('Done: 1)'));
    assert.equal((await api(t, (await makeUser(t)).token).get(`/classes/${k.c.id}/homework/${hid}`)).status, 404);
    // baholash
    assert.equal((await api(t, k.ps[0].token).post(`/classes/${k.c.id}/homework/${hid}/submissions/${k.ps[0].id}/mark`, { score: 100 })).status, 403);
    assert.equal((await api(t, k.x.user.token).post(`/classes/${k.c.id}/homework/${hid}/submissions/${k.ps[0].id}/mark`, { score: 101 })).status, 400);
    const m = await api(t, k.x.user.token).post(`/classes/${k.c.id}/homework/${hid}/submissions/${k.ps[0].id}/mark`, { score: 85, comment: 'Good, check task 3.' });
    assert.equal(m.status, 200, JSON.stringify(m.body));
    assert.equal(m.body.score, 85);
    assert.equal(await t.prisma.notification.count({ where: { userId: k.ps[0].id, type: 'class.homework_marked' } }), 1);
    assert.equal((await api(t, k.ps[0].token).post(`/classes/${k.c.id}/homework/${hid}/submit`, { text: 'change after marking' })).body.code, 'ALREADY_MARKED');
    assert.equal((await api(t, k.x.user.token).post(`/classes/${k.c.id}/homework/${hid}/submissions/${k.ps[2].id}/mark`, { score: 50 })).status, 404, 'no submission');
    assert.equal((await api(t, other.x.user.token).post(`/classes/${k.c.id}/homework/${hid}/submissions/${k.ps[0].id}/mark`, { score: 1 })).status, 404);
    assert.equal((await api(t, k.ps[0].token).get(`/classes/${k.c.id}/homework/${hid}`)).body.mine[0].comment, 'Good, check task 3.');
  });

  it('reminders: 1 day and 30 minutes before, to the teacher, pupils and guardians of minors; idempotent; stale ones removed on cancel, removal and leave', async () => {
    const k = await klass(2, { minor: true });
    const rem = t.app.get(ClassRemindersService);
    const day = (u: TestUser) => t.prisma.notification.findMany({ where: { userId: u.id, type: 'class.reminder_day' } });
    const half = (u: TestUser) => t.prisma.notification.findMany({ where: { userId: u.id, type: 'class.reminder_soon' } });
    for (const u of [k.x.user, k.ps[0], k.ps[1], k.guardian!, k.minor!]) {
      assert.equal((await day(u)).length, 1, 'day reminder ' + u.id);
      assert.equal((await half(u)).length, 1, '30 min reminder ' + u.id);
    }
    const d = (await day(k.ps[0]))[0];
    assert.equal(d.dueAt.toISOString(), '2026-11-04T10:00:00.000Z');
    assert.equal((await half(k.ps[0]))[0].dueAt.toISOString(), '2026-11-05T09:30:00.000Z');
    assert.deepEqual(d.data, { classId: k.c.id, sessionId: k.sid });
    assert.equal(await rem.sync(k.c.id), 0, 'idempotent');
    // o'quvchi chiqsa — uning eslatmalari o'chadi, boshqalarniki qoladi
    assert.equal((await api(t, k.ps[1].token).post(`/classes/${k.c.id}/leave`, {})).status, 200);
    assert.equal((await day(k.ps[1])).length, 0);
    assert.equal((await day(k.ps[0])).length, 1);
    // o'qituvchi chiqarsa
    assert.equal((await api(t, k.x.user.token).del(`/classes/${k.c.id}/pupils/${k.minor!.id}`)).status, 200);
    assert.equal((await half(k.minor!)).length + (await half(k.guardian!)).length, 0);
    // sessiya bekor
    assert.equal((await api(t, k.x.user.token).post(`/classes/${k.c.id}/sessions/${k.sid}/cancel`)).status, 200);
    assert.equal((await day(k.ps[0])).length + (await half(k.ps[0])).length + (await half(k.x.user)).length, 0, 'nothing stale for a cancelled session');
    // yuborilganlar saqlanadi: sentAt belgilangan bo'lsa tegilmaydi
    const k2 = await klass(1);
    await t.prisma.notification.updateMany({ where: { userId: k2.ps[0].id, type: 'class.reminder_day' }, data: { sentAt: new Date() } });
    await api(t, k2.x.user.token).post(`/classes/${k2.c.id}/cancel`);
    assert.equal((await day(k2.ps[0])).length, 1, 'already-sent reminders are history');
    assert.equal((await half(k2.ps[0])).length, 0);
  });

  it('weekly classes get reminders for each generated session; attendance history is private to the pupil and his guardian', async () => {
    const k = await klass(2, { minor: true, oneOff: false });
    const sessions = (await api(t, k.x.user.token).get(`/classes/${k.c.id}/sessions`)).body;
    assert.ok(sessions.length >= 8);
    const n = await t.prisma.notification.count({ where: { userId: k.ps[0].id, type: { in: ['class.reminder_day', 'class.reminder_soon'] } } });
    assert.ok(n >= 12 && n <= 2 * sessions.length, 'reminders exist for upcoming sessions: ' + n);
    // davomat tarixi: bitta sinf (bir martalik) bilan
    const one = await klass(2, { minor: true });
    await runClass(one);
    const mineRes = await api(t, one.ps[0].token).get(`/classes/${one.c.id}/attendance/mine`);
    assert.equal(mineRes.status, 200, JSON.stringify(mineRes.body));
    const mine = mineRes.body;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].attended, true);
    assert.equal(mine[0].pupil, 'Pupil0', 'first name only');
    const kid = (await api(t, one.guardian!.token).get(`/classes/${one.c.id}/attendance/mine`)).body;
    assert.equal(kid.length, 1);
    assert.equal(kid[0].attended, false);
    assert.equal(kid[0].pupil, 'Aziz');
    assert.equal((await api(t, one.x.user.token).get(`/classes/${one.c.id}/attendance/mine`)).status, 403);
    assert.equal((await api(t, (await makeUser(t)).token).get(`/classes/${one.c.id}/attendance/mine`)).status, 404);
    assert.equal((await api(t, k.ps[0].token).get(`/classes/${one.c.id}/attendance/mine`)).status, 404, 'a pupil of another class');
  });
});
