import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Role } from '@prisma/client';
import { ClockService } from '../common/clock';
import { api, checkRouteMatrix, createTestApp, makeAdmin, makeUser, seedVerifiedTeacher, TestApp, TestUser } from '../testing/harness';
import { bayesianAverage } from '../reviews/rating';

const NOW = new Date('2026-11-02T00:00:00Z');

describe('discovery (integration)', () => {
  let t: TestApp;
  let clock: ClockService;
  let student: TestUser;
  const tag = () => 'zq' + randomUUID().replace(/-/g, '').slice(0, 10); // izolyatsiya uchun noyob qidiruv so'zi

  const search = (qs: string, u = student) => api(t, u.token).get('/teachers?' + qs);

  before(async () => {
    t = await createTestApp();
    clock = t.app.get(ClockService);
    clock.set(NOW);
    student = await makeUser(t);
  });
  after(async () => {
    clock.set(null);
    await t.close();
  });

  it('route matrix', async () => {
    const admin = await makeAdmin(t);
    const actors = { STUDENT: student, GUARDIAN: await makeUser(t, Role.GUARDIAN), TEACHER: await makeUser(t, Role.TEACHER), adminToken: admin.token };
    const failures = await checkRouteMatrix(t, actors, [
      { method: 'GET', path: '/teachers', allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
      { method: 'GET', path: '/catalog', allowed: ['STUDENT', 'GUARDIAN', 'TEACHER'] },
    ]);
    assert.deepEqual(failures, []);
  });

  it('lists ONLY verified, active teachers; hides pending/rejected/suspended and suspended accounts', async () => {
    const k = tag();
    const ok = await seedVerifiedTeacher(t, { tag: k });
    await seedVerifiedTeacher(t, { tag: k, status: 'PENDING' });
    await seedVerifiedTeacher(t, { tag: k, status: 'REJECTED' });
    await seedVerifiedTeacher(t, { tag: k, status: 'SUSPENDED' });
    await seedVerifiedTeacher(t, { tag: k, userStatus: 'SUSPENDED' });
    const r = await search('q=' + k);
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 1);
    assert.equal(r.body.items[0].id, ok.profileId);
    assert.equal(r.body.items[0].verified, true);
  });

  it('item shape is public-safe: no email, user id, DOB, bio, credentials', async () => {
    const k = tag();
    const x = await seedVerifiedTeacher(t, { tag: k });
    const raw = JSON.stringify((await search('q=' + k)).body);
    for (const s of [x.user.email, x.user.id, 'dateOfBirth', 'passwordHash', 'storageKey']) assert.ok(!raw.includes(s), s);
    assert.ok(!('bio' in (await search('q=' + k)).body.items[0]));
  });

  it('filters: subject, level, language (any-of), price range, minimum rating', async () => {
    const k = tag();
    await seedVerifiedTeacher(t, { tag: k, subjects: ['math'], levels: ['university'], languages: ['uz'], priceMinor: 3_000_000 });
    await seedVerifiedTeacher(t, { tag: k, subjects: ['physics', 'math'], levels: ['grades_5_9'], languages: ['ru'], priceMinor: 6_000_000, ratingSum: 50, ratingCount: 10 });
    await seedVerifiedTeacher(t, { tag: k, subjects: ['english'], levels: ['adult'], languages: ['en', 'uz'], priceMinor: 9_000_000, ratingSum: 20, ratingCount: 4 });
    const n = async (qs: string) => (await search('q=' + k + '&' + qs)).body.total;
    assert.equal(await n(''), 3);
    assert.equal(await n('subject=math'), 2);
    assert.equal(await n('subject=physics,english'), 2);
    assert.equal(await n('level=adult'), 1);
    assert.equal(await n('language=uz'), 2);
    assert.equal(await n('language=ru,en'), 2);
    assert.equal(await n('minPrice=5000000'), 2);
    assert.equal(await n('maxPrice=6000000'), 2);
    assert.equal(await n('minPrice=5000000&maxPrice=7000000'), 1);
    assert.equal(await n('minRating=4.5'), 2);
    assert.equal(await n('minRating=4.7'), 1, 'Bayesian: 10 reviews avg 5.0 => 4.73; 4 reviews avg 5.0 => 4.56');
    assert.equal(await n('subject=math&language=ru&level=grades_5_9'), 1, 'filters combine with AND');
    assert.equal(await n('subject=history'), 0);
  });

  it('text search matches headline, bio and name, case-insensitively, and treats SQL/regex characters literally', async () => {
    const k = tag();
    const x = await seedVerifiedTeacher(t, { tag: k });
    assert.equal((await search('q=' + k.toUpperCase())).body.total, 1);
    assert.equal((await search("q=" + encodeURIComponent("' OR 1=1 --"))).body.total, 0);
    assert.equal((await search('q=' + encodeURIComponent('%'))).status, 200);
    assert.equal((await search('q=' + encodeURIComponent('T ' + k))).body.items[0].id, x.profileId, 'by name');
  });

  it('sorting is transparent and NOT pay-to-win: rating order ignores price, instant booking and age', async () => {
    const k = tag();
    const cheapGood = await seedVerifiedTeacher(t, { tag: k, priceMinor: 2_500_000, ratingSum: 95, ratingCount: 20 });
    const richBad = await seedVerifiedTeacher(t, { tag: k, priceMinor: 90_000_000, instant: true, ratingSum: 20, ratingCount: 10 });
    const noReviews = await seedVerifiedTeacher(t, { tag: k, priceMinor: 40_000_000, instant: true });
    const oneFive = await seedVerifiedTeacher(t, { tag: k, ratingSum: 5, ratingCount: 1 });
    const r = await search('q=' + k + '&sort=rating');
    assert.deepEqual(r.body.items.map((i: any) => i.id), [cheapGood.profileId, oneFive.profileId, noReviews.profileId, richBad.profileId]);
    // bitta 5 yulduz yangi o'qituvchidan ozgina ustun, lekin 20 ta 4.75 dan past
    assert.ok(r.body.items[1].rating.bayesian < r.body.items[0].rating.bayesian);
    assert.equal(r.body.ranking.paid, false);
    assert.match(r.body.ranking.description, /Bayesian/);
    const asc = (await search('q=' + k + '&sort=price_asc')).body.items.map((i: any) => i.priceMinor);
    assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
    const desc = (await search('q=' + k + '&sort=price_desc')).body.items.map((i: any) => i.priceMinor);
    assert.deepEqual(desc, [...desc].sort((a, b) => b - a));
    // faqat narx o'zgarsa reyting tartibi o'zgarmaydi
    await t.prisma.teacherProfile.update({ where: { id: cheapGood.profileId }, data: { priceMinor: 99_000_000, instantBooking: false } });
    assert.equal((await search('q=' + k + '&sort=rating')).body.items[0].id, cheapGood.profileId);
    assert.equal((await search('q=' + k + '&sort=bogus')).status, 400);
  });

  it('pagination: stable, no duplicates or gaps, caps page size', async () => {
    const k = tag();
    for (let i = 0; i < 23; i++) await seedVerifiedTeacher(t, { tag: k, ratingSum: i % 5 === 0 ? 5 : 0, ratingCount: i % 5 === 0 ? 1 : 0 });
    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const r = await search('q=' + k + '&pageSize=10&page=' + page);
      assert.equal(r.body.total, 23);
      assert.equal(r.body.items.length, page === 3 ? 3 : 10);
      assert.equal(r.body.hasMore, page < 3);
      seen.push(...r.body.items.map((i: any) => i.id));
    }
    assert.equal(new Set(seen).size, 23);
    assert.equal((await search('q=' + k + '&pageSize=10&page=4')).body.items.length, 0);
    assert.equal((await search('q=' + k + '&pageSize=9999')).body.pageSize, 50);
    assert.equal((await search('q=' + k + '&page=-5')).body.page, 1);
    // ikki marta so'rasak ham bir xil tartib (barqaror)
    const again = (await search('q=' + k + '&pageSize=10&page=1')).body.items.map((i: any) => i.id);
    assert.deepEqual(again, seen.slice(0, 10));
  });

  it('availability filter finds only teachers with a free slot in the range; respects bookings and time off', async () => {
    const k = tag();
    const free = await seedVerifiedTeacher(t, { tag: k, instant: true });
    const noHours = await seedVerifiedTeacher(t, { tag: k, rules: [{ weekday: 7, startMinute: 540, endMinute: 600 }] });
    const busy = await seedVerifiedTeacher(t, { tag: k, instant: true, rules: [{ weekday: 2, startMinute: 540, endMinute: 600 }] }); // seshanba 09-10 (faqat 1 soat)
    const off = await seedVerifiedTeacher(t, { tag: k, rules: [{ weekday: 2, startMinute: 540, endMinute: 600 }] });
    const range = 'availableFrom=2026-11-03T00:00:00Z&availableTo=2026-11-04T00:00:00Z&duration=60';
    let r = await search('q=' + k + '&' + range);
    assert.deepEqual(r.body.items.map((i: any) => i.id).sort(), [free.profileId, busy.profileId, off.profileId].sort());
    assert.equal(r.body.items.find((i: any) => i.id === free.profileId).nextSlot, '2026-11-03T04:00:00.000Z');
    // busy o'qituvchining yagona soati band qilinadi
    await api(t, (await makeUser(t)).token).post('/bookings', { teacherId: busy.profileId, startAt: '2026-11-03T04:00:00.000Z', durationMin: 60 });
    await t.prisma.teacherTimeOff.create({ data: { teacherId: off.profileId, startAt: new Date('2026-11-03T00:00:00Z'), endAt: new Date('2026-11-04T00:00:00Z') } });
    r = await search('q=' + k + '&' + range);
    assert.deepEqual(r.body.items.map((i: any) => i.id), [free.profileId]);
    assert.equal((await search('q=' + k + '&availableFrom=2026-11-03T00:00:00Z&availableTo=2026-12-30T00:00:00Z')).status, 400, 'range cap');
    assert.equal((await search('q=' + k + '&availableFrom=garbage&availableTo=2026-11-04T00:00:00Z')).status, 400);
    assert.ok(noHours);
  });

  it('input validation: unknown subject/level/language, inverted price, bad numbers', async () => {
    for (const qs of ['subject=astrology', 'level=phd', 'language=xx', 'minPrice=9&maxPrice=1', 'minPrice=abc', 'minRating=7', 'page=abc']) {
      assert.equal((await search(qs)).status, 400, qs);
    }
  });

  it('catalog documents the ranking rules', async () => {
    const c = (await api(t, student.token).get('/catalog')).body;
    assert.ok(c.subjects.includes('math') && c.languages.length === 3);
    assert.ok(c.ranking.rating);
  });

  it('performance: 600 verified teachers, filtered+sorted search stays fast and uses indexes', async () => {
    const k = tag();
    const users = Array.from({ length: 600 }, (_, i) => ({ id: randomUUID(), i }));
    await t.prisma.user.createMany({ data: users.map((u) => ({ id: u.id, email: `perf${u.i}-${u.id.slice(0, 6)}@test.local`, name: `P ${k} ${u.i}`, referralCode: 'R' + u.id.replace(/-/g, '').slice(0, 10), role: 'TEACHER' as const })) });
    await t.prisma.teacherProfile.createMany({
      data: users.map((u) => ({ userId: u.id, headline: `Perf ${k}`, bio: 'x', subjects: [u.i % 2 ? 'math' : 'physics'], levels: ['adult'], languages: ['uz'], priceMinor: 2_000_000 + u.i * 1000, verificationStatus: 'VERIFIED' as const, verifiedAt: new Date(), ratingBayes: 3 + (u.i % 20) / 10, ratingCount: u.i % 7 })),
    });
    const t0 = Date.now();
    const r = await search('q=' + k + '&subject=math&maxPrice=2500000&sort=rating&pageSize=20');
    const ms = Date.now() - t0;
    assert.equal(r.status, 200);
    assert.ok(r.body.total > 100);
    console.log(`    discovery: 600 teachers, filtered search took ${ms} ms (local DB; not a production number)`);
    assert.ok(ms < 1500, `search took ${ms} ms`);
    const idx = await t.prisma.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE tablename IN ('TeacherProfile','User')`;
    const names = idx.map((i) => i.indexname);
    for (const must of ['TeacherProfile_subjects_gin', 'TeacherProfile_verified_rating', 'TeacherProfile_verified_price', 'TeacherProfile_headline_trgm', 'User_name_trgm']) assert.ok(names.includes(must), must);
    const plan = await t.prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(`EXPLAIN SELECT id FROM "TeacherProfile" WHERE "verificationStatus"='VERIFIED' AND subjects && ARRAY['math'] ORDER BY "ratingBayes" DESC, id LIMIT 20`);
    assert.ok(plan.length > 0);
  });
});

describe('bayesian rating (pure)', () => {
  it('shrinks small samples toward the prior and converges for large ones', () => {
    assert.equal(bayesianAverage(0, 0, 4, 5), 4);
    assert.ok(bayesianAverage(5, 1, 4, 5) < 4.2);
    assert.ok(bayesianAverage(5 * 100, 100, 4, 5) > 4.9);
    assert.ok(bayesianAverage(95, 20, 4, 5) > bayesianAverage(5, 1, 4, 5));
    assert.throws(() => bayesianAverage(-1, 1));
  });
  it('monotonic: adding a higher rating never lowers the score below adding a lower rating', () => {
    for (let n = 0; n < 30; n++) assert.ok(bayesianAverage(4 * n + 5, n + 1, 4, 5) >= bayesianAverage(4 * n + 1, n + 1, 4, 5));
  });
});
