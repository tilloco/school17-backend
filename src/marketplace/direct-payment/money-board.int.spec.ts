import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { ClockService } from '../common/clock';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makeTeacher, makeUser, TestApp, TestUser } from '../testing/harness';
import { csvCell, monthRange, toCsv } from './csv';

const NOW = new Date('2026-11-12T00:00:00Z'); // payshanba
let n = 0;

describe('csv helpers (pure)', () => {
  it('quotes properly and neutralises spreadsheet formulas', () => {
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
    for (const bad of ['=HYPERLINK("http://evil","x")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd']) assert.ok(csvCell(bad).replace(/^"/, '').startsWith("'"), bad);
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(12), '12');
    assert.equal(toCsv(['a', 'b'], [[1, 'x,y']]), 'a,b\r\n1,"x,y"\r\n');
  });
  it('month ranges follow the teacher time zone', () => {
    const r = monthRange('2026-11', 'Asia/Tashkent')!;
    assert.equal(r.from.toISOString(), '2026-10-31T19:00:00.000Z');
    assert.equal(r.to.toISOString(), '2026-11-30T19:00:00.000Z');
    assert.equal(monthRange('2026-12', 'UTC')!.to.toISOString(), '2027-01-01T00:00:00.000Z');
    for (const bad of ['2026-13', '2026-1', 'x', '2026/11', '']) assert.equal(monthRange(bad, 'UTC'), null, bad);
  });
});

describe('teacher money board (A4, integration)', () => {
  let t: TestApp;
  let clock: ClockService;
  let admin: { id: string; token: string };

  const teacher = async () => {
    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    await api(t, x.user.token).put('/teachers/me/profile', { instantBooking: true });
    return x;
  };
  /** O'tgan (yakunlangan) dars + to'lov yozuvi */
  async function pastLesson(x: Awaited<ReturnType<typeof teacher>>, pupil: TestUser, opts: { status?: string; booker?: TestUser; studentId?: string } = {}) {
    clock.set(new Date('2026-11-02T00:00:00Z'));
    const days = ['03', '04', '05', '06', '09', '10', '11', '12'];
    const k = n++;
    const startAt = `2026-11-${days[k % 8]}T${String(4 + (Math.floor(k / 8) % 8)).padStart(2, '0')}:00:00.000Z`;
    const booker = opts.booker ?? pupil;
    const r = await api(t, booker.token).post('/bookings', { teacherId: x.profileId, startAt, durationMin: 60, ...(opts.studentId ? { studentId: opts.studentId } : {}) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await t.prisma.booking.update({ where: { id: r.body.id }, data: { status: (opts.status ?? 'COMPLETED') as any, completedAt: new Date('2026-11-05T00:00:00Z') } });
    clock.set(NOW);
    return r.body.id as string;
  }

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
    const id = '11111111-1111-4111-8111-111111111111';
    const failures = await checkRouteMatrix(t, actors, [
      { method: 'GET', path: '/teachers/me/money/owed', allowed: ['TEACHER'] },
      { method: 'GET', path: '/teachers/me/money/income', allowed: ['TEACHER'] },
      { method: 'GET', path: '/teachers/me/money/export.csv', allowed: ['TEACHER'] },
      { method: 'POST', path: '/teachers/me/money/remind', body: { bookingId: id }, allowed: ['TEACHER'] },
      { method: 'GET', path: '/direct-payments/mine', allowed: ['STUDENT', 'GUARDIAN'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('"who owes me": grouped per pupil, only past unpaid lessons, minors abbreviated, no ids; other teachers see nothing', async () => {
    const x = await teacher();
    const other = await teacher();
    const ali = await makeUser(t, Role.STUDENT, { name: 'Ali Valiyev' });
    const guardian = await makeUser(t, Role.GUARDIAN);
    const minor = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05', name: 'Aziz Karimov' });
    await t.prisma.guardianLink.create({ data: { guardianId: guardian.id, studentId: minor.id, status: 'ACTIVE' } });
    const a1 = await pastLesson(x, ali);
    const a2 = await pastLesson(x, ali, { status: 'NO_SHOW_STUDENT' });
    const m1 = await pastLesson(x, minor, { booker: guardian, studentId: minor.id });
    const paid = await pastLesson(x, ali);
    await api(t, x.user.token).post(`/bookings/${paid}/direct-payment/received`, {});
    await pastLesson(x, ali, { status: 'NO_SHOW_TEACHER' }); // o'qituvchi kelmagan: qarz emas
    await pastLesson(x, ali, { status: 'CONFIRMED' }); // hali o'tmagan/yakunlanmagan: qarz emas
    const res = (await api(t, x.user.token).get('/teachers/me/money/owed')).body;
    assert.equal(res.length, 2);
    const byName = Object.fromEntries(res.map((g: any) => [g.pupilName, g]));
    assert.equal(byName['Ali Valiyev'].count, 2);
    assert.equal(byName['Ali Valiyev'].totalMinor, 10_000_000);
    assert.deepEqual(byName['Ali Valiyev'].lessons.map((l: any) => l.bookingId).sort(), [a1, a2].sort());
    assert.equal(byName['Aziz K.'].count, 1, 'minors are shown as "First L."');
    assert.equal(byName['Aziz K.'].lessons[0].bookingId, m1);
    const raw = JSON.stringify(res);
    for (const secret of [ali.id, ali.email, minor.id, guardian.id, guardian.email, 'Karimov']) assert.ok(!raw.includes(secret), secret);
    assert.deepEqual((await api(t, other.user.token).get('/teachers/me/money/owed')).body, []);
  });

  it('remind: once per pupil per 24 h, pupil and booker are notified, message never has card details; foreign/paid lessons are refused', async () => {
    const x = await teacher();
    await api(t, x.user.token).put('/teachers/me/payment-info', { cardNumber: '4111 1111 1111 1111', holderName: 'Ali Valiyev' });
    const other = await teacher();
    const pupil = await makeUser(t);
    const b1 = await pastLesson(x, pupil);
    await pastLesson(x, pupil);
    assert.equal((await api(t, other.user.token).post('/teachers/me/money/remind', { bookingId: b1 })).status, 404, 'another teacher');
    assert.equal((await api(t, pupil.token).post('/teachers/me/money/remind', { bookingId: b1 })).status, 403);
    const ok = await api(t, x.user.token).post('/teachers/me/money/remind', { bookingId: b1 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.reminded, 2);
    const note = await t.prisma.notification.findFirstOrThrow({ where: { userId: pupil.id, type: 'directpay.reminder' } });
    assert.ok(!JSON.stringify(note).includes('4111'));
    const again = await api(t, x.user.token).post('/teachers/me/money/remind', { bookingId: b1 });
    assert.equal(again.status, 429);
    assert.equal(again.body.code, 'REMIND_LIMIT');
    assert.equal((await api(t, x.user.token).get('/teachers/me/money/owed')).body[0].canRemind, false);
    clock.set(new Date(NOW.getTime() + 25 * 3_600_000));
    assert.equal((await api(t, x.user.token).post('/teachers/me/money/remind', { bookingId: b1 })).status, 200, 'allowed again after 24 h');
    clock.set(NOW);
    // hamma to'langan bo'lsa eslatma yo'q
    const y = await teacher();
    const p2 = await makeUser(t);
    const only = await pastLesson(y, p2);
    await api(t, y.user.token).post(`/bookings/${only}/direct-payment/received`, {});
    const r = await api(t, y.user.token).post('/teachers/me/money/remind', { bookingId: only });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'NOTHING_OWED');
  });

  it('monthly income counts only teacher-confirmed payments in the teacher\'s own month; also awaiting/unpaid counters', async () => {
    const x = await teacher();
    const s = await makeUser(t);
    const l1 = await pastLesson(x, s);
    const l2 = await pastLesson(x, s);
    const l3 = await pastLesson(x, s);
    await pastLesson(x, s);
    await api(t, x.user.token).post(`/bookings/${l1}/direct-payment/received`, {});
    await api(t, x.user.token).post(`/bookings/${l2}/direct-payment/received`, {});
    await api(t, s.token).post(`/bookings/${l3}/direct-payment/paid`, {});
    const inc = (await api(t, x.user.token).get('/teachers/me/money/income?month=2026-11')).body;
    assert.equal(inc.confirmedCount, 2);
    assert.equal(inc.confirmedMinor, 10_000_000);
    assert.equal(inc.awaitingConfirmation, 1);
    assert.equal(inc.unpaidLessons, 1);
    assert.equal(inc.timezone, 'Asia/Tashkent');
    assert.equal((await api(t, x.user.token).get('/teachers/me/money/income?month=2026-10')).body.confirmedCount, 0, 'other months');
    assert.equal((await api(t, x.user.token).get('/teachers/me/money/income')).body.month, '2026-11', 'defaults to the current month');
    assert.equal((await api(t, x.user.token).get('/teachers/me/money/income?month=nope')).status, 400);
    // oy chegarasi: 2026-11-30T19:30Z (Toshkentda 1-dekabr 00:30) dekabrga tegishli
    const dp = await t.prisma.directPayment.findUniqueOrThrow({ where: { bookingId: l1 } });
    await t.prisma.directPayment.update({ where: { id: dp.id }, data: { teacherConfirmedAt: new Date('2026-11-30T19:30:00Z') } });
    assert.equal((await api(t, x.user.token).get('/teachers/me/money/income?month=2026-11')).body.confirmedCount, 1);
    assert.equal((await api(t, x.user.token).get('/teachers/me/money/income?month=2026-12')).body.confirmedCount, 1);
    // boshqa o'qituvchi hech narsani ko'rmaydi
    assert.equal((await api(t, (await teacher()).user.token).get('/teachers/me/money/income?month=2026-11')).body.confirmedCount, 0);
  });

  it('CSV export: only own rows, safe against formula injection, attachment headers, range limits', async () => {
    const x = await teacher();
    const other = await teacher();
    const evil = await makeUser(t, Role.STUDENT, { name: '=HYPERLINK("http://evil","click")' });
    const normal = await makeUser(t, Role.STUDENT, { name: 'Vali Aliyev' });
    await pastLesson(x, evil);
    await pastLesson(x, normal);
    await pastLesson(other, normal);
    const res = await fetch(t.baseUrl + '/teachers/me/money/export.csv?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z', { headers: { authorization: 'Bearer ' + x.user.token } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /^text\/csv/);
    assert.match(res.headers.get('content-disposition')!, /^attachment;/);
    const csv = await res.text();
    const lines = csv.trim().split('\r\n');
    assert.equal(lines[0], 'date_utc,pupil,minutes,amount_uzs,lesson_status,payment_mark,confirmed_at_utc');
    assert.equal(lines.length, 3, 'header + the teacher\'s own 2 rows');
    assert.ok(csv.includes('"\'=HYPERLINK(""http://evil"",""click"")"'), 'formula is neutralised');
    assert.ok(!csv.split('\r\n').some((l) => /,=|^=/.test(l)));
    assert.ok(csv.includes('Vali Aliyev') && csv.includes(',50000,'));
    assert.ok(![normal.email, evil.email, normal.id].some((s) => csv.includes(s)));
    assert.equal((await fetch(t.baseUrl + '/teachers/me/money/export.csv?from=2020-01-01&to=2026-12-01', { headers: { authorization: 'Bearer ' + x.user.token } })).status, 400, 'range cap');
    assert.equal((await fetch(t.baseUrl + '/teachers/me/money/export.csv?from=garbage', { headers: { authorization: 'Bearer ' + x.user.token } })).status, 400);
    assert.equal((await fetch(t.baseUrl + '/teachers/me/money/export.csv')).status, 401);
  });

  it('pupil / guardian "my payments": own lessons only, with teacher name and status', async () => {
    const x = await teacher();
    const s = await makeUser(t);
    const stranger = await makeUser(t);
    const g = await makeUser(t, Role.GUARDIAN);
    const minor = await makeUser(t, Role.STUDENT, { dateOfBirth: '2012-05-05' });
    await t.prisma.guardianLink.create({ data: { guardianId: g.id, studentId: minor.id, status: 'ACTIVE' } });
    const mine = await pastLesson(x, s);
    const kid = await pastLesson(x, minor, { booker: g, studentId: minor.id });
    const list = (await api(t, s.token).get('/direct-payments/mine')).body;
    assert.deepEqual(list.map((r: any) => r.bookingId), [mine]);
    assert.equal(list[0].status, 'UNPAID');
    assert.equal(list[0].amountMinor, 5_000_000);
    assert.deepEqual((await api(t, stranger.token).get('/direct-payments/mine')).body, []);
    assert.deepEqual((await api(t, g.token).get('/direct-payments/mine')).body.map((r: any) => r.bookingId), [kid]);
    assert.deepEqual((await api(t, minor.token).get('/direct-payments/mine')).body.map((r: any) => r.bookingId), [kid]);
    assert.equal((await api(t, x.user.token).get('/direct-payments/mine')).status, 403);
    assert.ok(!JSON.stringify(list).includes(x.user.id) && !JSON.stringify(list).includes(x.user.email));
  });
});
