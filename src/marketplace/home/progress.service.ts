import { Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../common/actor';
import { ClockService } from '../common/clock';
import { ClassRankingService } from '../classes/class-ranking.service';

export const WEEKLY_GOAL = 3; // things done in a week: lessons attended + homework handed in
const DAY = 86_400_000;

/** "2026-10-17" in the user's own time zone, so a lesson at 23:30 counts for that evening. */
export function dayKey(d: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** Pure: how many days in a row (ending today, or yesterday if today is still empty) have something done. */
export function streakOf(days: Set<string>, todayKey: string): { streak: number; todayDone: boolean } {
  const step = (k: string, by: number) => new Date(Date.parse(k + 'T12:00:00Z') + by * DAY).toISOString().slice(0, 10);
  const todayDone = days.has(todayKey);
  let k = todayDone ? todayKey : step(todayKey, -1);
  let n = 0;
  while (days.has(k)) { n++; k = step(k, -1); }
  return { streak: n, todayDone };
}

/** Pure: the Monday (yyyy-mm-dd) of the week that contains `key`. */
export function weekStartKey(key: string): string {
  const d = new Date(key + 'T12:00:00Z');
  const back = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(d.getTime() - back * DAY).toISOString().slice(0, 10);
}

/** What a pupil sees on Home: streak, this week's goal and where they stand in their classes. Real numbers only, no padding. */
@Injectable()
export class ProgressService {
  constructor(private prisma: PrismaService, private clock: ClockService, private ranking: ClassRankingService) {}

  async mine(actor: Actor) {
    if (actor.role !== Role.STUDENT) return { eligible: false as const };
    const now = this.clock.now();
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { timezone: true } });
    const tz = user.timezone || 'Asia/Tashkent';
    const since = new Date(now.getTime() - 120 * DAY);
    const [att, subs, books, enrolls] = await Promise.all([
      this.prisma.classAttendance.findMany({ where: { pupilId: actor.id, firstJoinedAt: { gte: since } }, select: { firstJoinedAt: true } }),
      this.prisma.classHomeworkSubmission.findMany({ where: { pupilId: actor.id, submittedAt: { gte: since } }, select: { submittedAt: true } }),
      this.prisma.booking.findMany({ where: { studentId: actor.id, status: 'COMPLETED', completedAt: { gte: since } }, select: { completedAt: true } }),
      this.prisma.classEnrollment.findMany({ where: { pupilId: actor.id, status: 'ACTIVE', class: { status: 'ACTIVE' } }, select: { classId: true, class: { select: { title: true } } }, take: 5 }),
    ]);
    const stamps = [...att.map((a) => a.firstJoinedAt), ...subs.map((s) => s.submittedAt), ...books.map((b) => b.completedAt as Date)];
    const days = new Set(stamps.map((d) => dayKey(d, tz)));
    const today = dayKey(now, tz);
    const { streak, todayDone } = streakOf(days, today);
    const ws = weekStartKey(today);
    const inWeek = (d: Date) => dayKey(d, tz) >= ws;
    const lessons = att.filter((a) => inWeek(a.firstJoinedAt)).length + books.filter((b) => inWeek(b.completedAt as Date)).length;
    const homework = subs.filter((s) => inWeek(s.submittedAt)).length;
    const ranks = [];
    for (const e of enrolls) {
      const r = await this.ranking.ranking(actor, e.classId).catch(() => null);
      const me = r?.items.find((i) => i.mine);
      if (me) ranks.push({ classId: e.classId, title: e.class.title, rank: me.rank, of: r!.items.length, points: me.points });
    }
    ranks.sort((a, b) => a.rank / a.of - b.rank / b.of);
    return {
      eligible: true as const,
      streak, todayDone,
      week: { lessons, homework, done: lessons + homework, goal: WEEKLY_GOAL, reached: lessons + homework >= WEEKLY_GOAL },
      ranks,
      isNew: stamps.length === 0 && enrolls.length === 0,
    };
  }
}
