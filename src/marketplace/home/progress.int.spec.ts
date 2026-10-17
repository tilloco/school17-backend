import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import { ClockService } from '../common/clock';
import { api, createTestApp, makeAdmin, makeTeacher, makeUser, TestApp } from '../testing/harness';
import { dayKey, streakOf, weekStartKey } from './progress.service';

describe('progress: pure rules', () => {
  it('streak counts consecutive days, stays alive until the end of the next day, and breaks on a gap', () => {
    const d = new Set(['2026-11-09', '2026-11-10', '2026-11-11']);
    assert.deepEqual(streakOf(d, '2026-11-11'), { streak: 3, todayDone: true });
    assert.deepEqual(streakOf(d, '2026-11-12'), { streak: 3, todayDone: false }, 'yesterday still counts');
    assert.deepEqual(streakOf(d, '2026-11-13'), { streak: 0, todayDone: false }, 'a missed day breaks it');
    assert.deepEqual(streakOf(new Set(['2026-11-05', '2026-11-07', '2026-11-08']), '2026-11-08'), { streak: 2, todayDone: true });
    assert.deepEqual(streakOf(new Set(), '2026-11-08'), { streak: 0, todayDone: false });
  });
  it('the week starts on Monday and a day is read in the pupil time zone', () => {
    assert.equal(weekStartKey('2026-11-12'), '2026-11-09'); // Thursday
    assert.equal(weekStartKey('2026-11-09'), '2026-11-09'); // Monday
    assert.equal(weekStartKey('2026-11-15'), '2026-11-09'); // Sunday
    assert.equal(dayKey(new Date('2026-11-11T20:30:00Z'), 'Asia/Tashkent'), '2026-11-12', 'late evening in UTC is already tomorrow in Tashkent');
  });
});

describe('progress endpoint (integration)', () => {
  let t: TestApp;
  let clock: ClockService;
  const NOW = new Date('2026-11-12T08:00:00Z');
  before(async () => { t = await createTestApp(); clock = t.app.get(ClockService); clock.set(NOW); });
  after(async () => { clock.set(null); await t.close(); });

  it('a new pupil is "new"; finished lessons and homework build the streak and the weekly goal; teachers get nothing', async () => {
    const admin = await makeAdmin(t);
    const pupil = await makeUser(t, Role.STUDENT);
    const fresh = (await api(t, pupil.token).get('/me/progress')).body;
    assert.equal(fresh.eligible, true);
    assert.equal(fresh.isNew, true);
    assert.equal(fresh.streak, 0);
    assert.equal(fresh.week.goal, 3);

    const x = await makeTeacher(t, { approve: { adminToken: admin.token } });
    const mk = async (daysAgo: number) => {
      const b = await t.prisma.booking.create({
        data: { teacherId: x.profileId, studentId: pupil.id, bookedById: pupil.id, startAt: new Date(NOW.getTime() - daysAgo * 86_400_000 - 3_600_000), endAt: new Date(NOW.getTime() - daysAgo * 86_400_000), durationMin: 60, status: 'COMPLETED', completedAt: new Date(NOW.getTime() - daysAgo * 86_400_000), priceMinor: 0, currency: 'UZS' } as any,
      });
      return b.id;
    };
    await mk(0); await mk(1); await mk(2);
    const p = (await api(t, pupil.token).get('/me/progress')).body;
    assert.equal(p.isNew, false);
    assert.equal(p.streak, 3);
    assert.equal(p.todayDone, true);
    assert.equal(p.week.lessons >= 1, true);

    assert.equal((await api(t, x.user.token).get('/me/progress')).body.eligible, false, 'teachers have no pupil progress');
    assert.equal((await fetch(t.baseUrl + '/me/progress')).status, 401);
  });
});
