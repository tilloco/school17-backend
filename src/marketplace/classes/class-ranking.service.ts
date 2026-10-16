import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor, ADULT_AGE, ageInYears } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { ClockService } from '../common/clock';
import { displayName } from '../booking/booking-rules';

/** Reyting ballari (ochiq formula, ilovada ham yoziladi): davomat 50, uy vazifasi 30, so'rovnomalarda ishtirok 20; mavjud bo'lmagan qism hisobga olinmaydi (jami 100 ga keltiriladi). Bonus ballar ustiga qo'shiladi. */
export const WEIGHTS = { attendance: 50, homework: 30, polls: 20 } as const;
export const BONUS_MAX_POINTS = 20;

export interface RankInput { attendance: { done: number; total: number }; homework: { done: number; total: number; avgScore: number | null }; polls: { done: number; total: number }; bonus: number }

/** Sof hisob (testlanadi): 0..100 + bonus. */
export function scoreOf(i: RankInput): { base: number; total: number } {
  const parts: { w: number; v: number }[] = [];
  if (i.attendance.total > 0) parts.push({ w: WEIGHTS.attendance, v: Math.min(1, i.attendance.done / i.attendance.total) });
  if (i.homework.total > 0) parts.push({ w: WEIGHTS.homework, v: Math.min(1, i.homework.done / i.homework.total) * (i.homework.avgScore === null ? 1 : 0.5 + 0.5 * (i.homework.avgScore / 100)) });
  if (i.polls.total > 0) parts.push({ w: WEIGHTS.polls, v: Math.min(1, i.polls.done / i.polls.total) });
  const wsum = parts.reduce((a, p) => a + p.w, 0);
  const base = wsum ? Math.round((parts.reduce((a, p) => a + p.w * p.v, 0) / wsum) * 1000) / 10 : 0;
  return { base, total: Math.round((base + i.bonus) * 10) / 10 };
}

@Injectable()
export class ClassRankingService {
  constructor(private prisma: PrismaService, private clock: ClockService, private audit: AuditService) {}

  private async ctx(actor: Actor, classId: string) {
    const c = await this.prisma.class.findUnique({ where: { id: classId }, select: { id: true, teacher: { select: { userId: true } } } });
    if (!c) throw new NotFoundException('Class not found');
    if (c.teacher.userId === actor.id) return { teacher: true };
    if (actor.role === Role.STUDENT && (await this.prisma.classEnrollment.findFirst({ where: { classId, pupilId: actor.id, status: 'ACTIVE' }, select: { id: true } }))) return { teacher: false };
    throw new NotFoundException('Class not found');
  }

  async ranking(actor: Actor, classId: string) {
    const { teacher } = await this.ctx(actor, classId);
    const now = this.clock.now();
    const enrollments = await this.prisma.classEnrollment.findMany({
      where: { classId, status: 'ACTIVE' }, take: 500,
      select: { pupilId: true, createdAt: true, pupil: { select: { name: true, username: true, dateOfBirth: true, avatarFileId: true } } },
    });
    const ids = enrollments.map((e) => e.pupilId);
    const allSessions = (await this.prisma.classSession.findMany({ where: { classId }, select: { id: true } })).map((x) => x.id);
    const [sessions, attendance, homework, subs, polls, votes, bonuses] = await Promise.all([
      this.prisma.classSession.findMany({ where: { classId, status: 'ENDED', teacherNoShow: false }, select: { id: true, startAt: true } }),
      this.prisma.classAttendance.findMany({ where: { pupilId: { in: ids }, session: { classId, status: 'ENDED', teacherNoShow: false } }, select: { pupilId: true, sessionId: true } }),
      this.prisma.classHomework.findMany({ where: { classId }, select: { id: true, createdAt: true } }),
      this.prisma.classHomeworkSubmission.findMany({ where: { pupilId: { in: ids }, homework: { classId } }, select: { pupilId: true, homeworkId: true, late: true, score: true } }),
      this.prisma.classPoll.findMany({ where: { sessionId: { in: allSessions } }, select: { id: true, openedAt: true } }),
      this.prisma.classPollVote.findMany({ where: { pupilId: { in: ids }, poll: { sessionId: { in: allSessions } } }, select: { pupilId: true, pollId: true } }),
      this.prisma.classBonus.groupBy({ by: ['pupilId'], where: { classId }, _sum: { points: true } }),
    ]);
    const bonusOf = new Map(bonuses.map((b) => [b.pupilId, b._sum.points ?? 0]));
    const rows = enrollments.map((e) => {
      const since = e.createdAt;
      const mySessions = sessions.filter((s) => s.startAt >= new Date(since.getTime() - 3_600_000)); // only lessons held after the pupil joined
      const sessionIds = new Set(mySessions.map((s) => s.id));
      const attended = new Set(attendance.filter((a) => a.pupilId === e.pupilId && sessionIds.has(a.sessionId)).map((a) => a.sessionId)).size;
      const myHw = homework.filter((h) => h.createdAt >= since);
      const mine = subs.filter((s) => s.pupilId === e.pupilId && myHw.some((h) => h.id === s.homeworkId));
      const hwDone = mine.reduce((a, s) => a + (s.late ? 0.5 : 1), 0);
      const scores = mine.filter((s) => s.score !== null).map((s) => s.score as number);
      const myPolls = polls.filter((p) => p.openedAt >= since);
      const pollDone = votes.filter((v) => v.pupilId === e.pupilId && myPolls.some((p) => p.id === v.pollId)).length;
      const bonus = bonusOf.get(e.pupilId) ?? 0;
      const input: RankInput = { attendance: { done: attended, total: mySessions.length }, homework: { done: hwDone, total: myHw.length, avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null }, polls: { done: pollDone, total: myPolls.length }, bonus };
      const minor = !e.pupil.dateOfBirth || ageInYears(e.pupil.dateOfBirth, now) < ADULT_AGE;
      return {
        input, ...scoreOf(input), minor,
        pupilId: e.pupilId, name: displayName(e.pupil.name, minor),
        // minors' @username and photo are shown to their teacher only
        username: teacher || !minor ? e.pupil.username : null, hasPhoto: (teacher || !minor) && !!e.pupil.avatarFileId,
      };
    });
    rows.sort((a, b) => b.total - a.total || b.input.attendance.done - a.input.attendance.done || a.name.localeCompare(b.name));
    const items = rows.map((r, i) => ({
      rank: i + 1, name: r.name, username: r.username, hasPhoto: r.hasPhoto,
      userId: teacher || !r.minor ? r.pupilId : null, // needed for the photo and for starting a chat
      mine: r.pupilId === actor.id,
      points: r.total, base: r.base, bonus: r.input.bonus,
      attendance: { attended: r.input.attendance.done, total: r.input.attendance.total, percent: r.input.attendance.total ? Math.round((r.input.attendance.done / r.input.attendance.total) * 100) : null },
      homework: { done: Math.round(r.input.homework.done * 10) / 10, total: r.input.homework.total, avgScore: r.input.homework.avgScore === null ? null : Math.round(r.input.homework.avgScore) },
      polls: { done: r.input.polls.done, total: r.input.polls.total },
    }));
    return { weights: WEIGHTS, canGiveBonus: teacher, bonusMax: BONUS_MAX_POINTS, items };
  }

  async giveBonus(actor: Actor, classId: string, pupilId: string, points: number, note?: string) {
    const { teacher } = await this.ctx(actor, classId);
    if (!teacher) throw new ForbiddenException('Teacher only');
    if (!Number.isInteger(points) || points < 1 || points > BONUS_MAX_POINTS) throw new BadRequestException(`Bonus must be 1..${BONUS_MAX_POINTS} points`);
    const e = await this.prisma.classEnrollment.findFirst({ where: { classId, pupilId, status: 'ACTIVE' }, select: { id: true } });
    if (!e) throw new NotFoundException('Pupil not found');
    const row = await this.prisma.classBonus.create({ data: { classId, pupilId, points, note: (note ?? '').trim().slice(0, 140), createdAt: this.clock.now() } });
    await this.audit.log(actor, { action: 'class.bonus', targetType: 'Class', targetId: classId, metadata: { pupilId, points } });
    return { id: row.id };
  }
}
