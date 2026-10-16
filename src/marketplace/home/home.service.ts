import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { BookingStatus, DirectPaymentStatus, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor, ADULT_AGE, ageInYears } from '../common/actor';
import { ClockService } from '../common/clock';
import { displayName } from '../booking/booking-rules';
import { BookingService } from '../booking/booking.service';
import { monthRange } from '../direct-payment/csv';
import { GuardianService } from '../guardian/guardian.service';
import { MessagingService } from '../messaging/messaging.service';

const DAY = 86_400_000;
const OWED: DirectPaymentStatus[] = ['UNPAID', 'NOT_RECEIVED'];

export interface AgendaItem {
  kind: 'lesson' | 'class';
  id: string; // bookingId yoki sessionId
  classId?: string;
  startAt: Date;
  endAt: Date;
  title: string;
  counterpart: string; // o'qituvchi uchun: o'quvchi; o'quvchi uchun: o'qituvchi
  pupil?: string; // vasiy uchun: qaysi bola (ism)
  status: string;
  canJoin: boolean;
  isTrial?: boolean;
}

/** Bosh ekran (rolga qarab) va "mening o'qishim" (o'quvchi/vasiy) uchun yig'ma ma'lumotlar. Bitta so'rov = bitta ekran. */
@Injectable()
export class HomeService {
  constructor(private prisma: PrismaService, private clock: ClockService, private bookings: BookingService, private messaging: MessagingService, private guardians: GuardianService) {}

  async seats(actor: Actor): Promise<string[]> {
    if (actor.role === Role.STUDENT) return [actor.id];
    if (actor.role === Role.GUARDIAN) return this.guardians.linkedStudentIds(actor.id);
    return [];
  }

  /** Dars va sinf sessiyalaridan birlashgan kun tartibi */
  async agenda(actor: Actor, from: Date, to: Date, limit = 30): Promise<AgendaItem[]> {
    const lessons = await this.bookings.list(actor, from, to, ['REQUESTED', 'CONFIRMED'] as BookingStatus[]);
    const seats = await this.seats(actor);
    const sessions = await this.prisma.classSession.findMany({
      where: {
        startAt: { gte: from, lt: to }, status: { in: ['SCHEDULED', 'LOBBY', 'LIVE'] },
        class: actor.role === Role.TEACHER ? { teacher: { userId: actor.id }, status: 'ACTIVE' } : { status: 'ACTIVE', enrollments: { some: { pupilId: { in: seats }, status: 'ACTIVE' } } },
      },
      orderBy: { startAt: 'asc' }, take: 100,
      include: { class: { select: { id: true, title: true, teacher: { select: { user: { select: { name: true } } } }, enrollments: { where: { pupilId: { in: seats }, status: 'ACTIVE' }, select: { pupil: { select: { name: true } } } } } } },
    });
    const now = this.clock.now();
    const out: AgendaItem[] = [
      ...lessons.map((b: any): AgendaItem => ({
        kind: 'lesson', id: b.id, startAt: new Date(b.startAt), endAt: new Date(b.endAt), title: '', status: b.status, canJoin: !!b.canJoinNow, isTrial: !!b.isTrial,
        counterpart: (b.myRole === 'teacher' ? b.student?.name : b.teacher?.name) ?? '', pupil: actor.role === Role.GUARDIAN ? (b.student?.name ?? undefined) : undefined,
      })),
      ...sessions.map((s): AgendaItem => ({
        kind: 'class', id: s.id, classId: s.classId, startAt: s.startAt, endAt: s.endAt, title: s.class.title, status: s.status, isTrial: s.isTrial,
        canJoin: s.status === 'LIVE' || (s.status === 'LOBBY' && s.endAt > now),
        counterpart: actor.role === Role.TEACHER ? '' : s.class.teacher.user.name ?? '',
        pupil: actor.role === Role.GUARDIAN ? (s.class.enrollments[0]?.pupil.name?.split(/\s+/)[0] ?? undefined) : undefined,
      })),
    ];
    return out.sort((a, b) => a.startAt.getTime() - b.startAt.getTime()).slice(0, limit);
  }

  async home(actor: Actor) {
    if (actor.role === Role.ADMIN) throw new ForbiddenException('Forbidden');
    const now = this.clock.now();
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { name: true, timezone: true } });
    const agenda = await this.agenda(actor, new Date(now.getTime() - 2 * 3_600_000), new Date(now.getTime() + 8 * DAY), 20);
    const [unreadNotifications, unreadMessages] = await Promise.all([
      this.prisma.notification.count({ where: { userId: actor.id, readAt: null, dueAt: { lte: now } } }),
      this.messaging.unreadTotal(actor).catch(() => 0),
    ]);
    const base = { role: actor.role, name: user.name, now, agenda, counts: { unreadNotifications, unreadMessages } as Record<string, number> };
    if (actor.role === Role.TEACHER) {
      const month = monthRange(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`, user.timezone) ?? { from: new Date(now.getTime() - 30 * DAY), to: now };
      const [pendingRequests, homeworkToMark, owedLessons, owedClass, direct, cls, students, classCount] = await Promise.all([
        this.prisma.booking.count({ where: { teacher: { userId: actor.id }, status: 'REQUESTED' } }),
        this.prisma.classHomeworkSubmission.count({ where: { markedAt: null, homework: { class: { teacher: { userId: actor.id } } } } }),
        this.prisma.directPayment.count({ where: { status: { in: OWED }, booking: { teacher: { userId: actor.id }, isTrial: false, status: { in: ['COMPLETED', 'NO_SHOW_STUDENT'] } } } }),
        this.prisma.classPayment.count({ where: { status: { in: OWED }, class: { teacher: { userId: actor.id } } } }),
        this.prisma.directPayment.aggregate({ _sum: { amountMinor: true }, where: { status: 'TEACHER_CONFIRMED', teacherConfirmedAt: { gte: month.from, lt: month.to }, booking: { teacher: { userId: actor.id } } } }),
        this.prisma.classPayment.aggregate({ _sum: { amountMinor: true }, where: { status: 'TEACHER_CONFIRMED', teacherConfirmedAt: { gte: month.from, lt: month.to }, class: { teacher: { userId: actor.id } } } }),
        this.prisma.booking.findMany({ where: { teacher: { userId: actor.id }, status: { in: ['CONFIRMED', 'COMPLETED'] } }, distinct: ['studentId'], select: { studentId: true }, take: 1000 }),
        this.prisma.class.count({ where: { teacher: { userId: actor.id }, status: 'ACTIVE' } }),
      ]);
      const classPupils = await this.prisma.classEnrollment.findMany({ where: { status: 'ACTIVE', class: { teacher: { userId: actor.id } } }, distinct: ['pupilId'], select: { pupilId: true }, take: 2000 });
      base.counts = { ...base.counts, pendingRequests, homeworkToMark, owed: owedLessons + owedClass, students: new Set([...students.map((s) => s.studentId), ...classPupils.map((p) => p.pupilId)]).size, classes: classCount };
      return { ...base, monthIncomeMinor: Number(direct._sum.amountMinor ?? 0n) + Number(cls._sum.amountMinor ?? 0n) };
    }
    const seats = await this.seats(actor);
    const homework = await this.prisma.classHomework.findMany({
      where: { dueAt: { gt: new Date(now.getTime() - 7 * DAY) }, class: { status: 'ACTIVE', enrollments: { some: { pupilId: { in: seats }, status: 'ACTIVE' } } } },
      orderBy: { dueAt: 'asc' }, take: 50, include: { submissions: { where: { pupilId: { in: seats } }, select: { pupilId: true } }, class: { select: { title: true } } },
    });
    const open = homework.filter((h) => h.submissions.length === 0);
    const [owedLessons, owedClass] = await Promise.all([
      this.prisma.directPayment.count({ where: { status: { in: OWED }, booking: { studentId: { in: seats }, isTrial: false, status: { in: ['COMPLETED', 'NO_SHOW_STUDENT'] } } } }),
      this.prisma.classPayment.count({ where: { status: { in: OWED }, pupilId: { in: seats } } }),
    ]);
    base.counts = { ...base.counts, homeworkDue: open.length, owed: owedLessons + owedClass, children: actor.role === Role.GUARDIAN ? seats.length : 0 };
    return { ...base, homework: open.slice(0, 5).map((h) => ({ id: h.id, classId: h.classId, classTitle: h.class.title, title: h.title, dueAt: h.dueAt, overdue: h.dueAt < now })) };
  }

  /** O'quvchi/vasiy: sinflarim, kelgusi darslar, o'qish tarixi va statistika (guardian: studentId bola tanlaydi) */
  async learning(actor: Actor, studentId?: string) {
    if (actor.role !== Role.STUDENT && actor.role !== Role.GUARDIAN) throw new ForbiddenException('Forbidden');
    const seats = await this.seats(actor);
    const pupilId = studentId ?? seats[0];
    if (!pupilId || !seats.includes(pupilId)) throw new NotFoundException('Pupil not found');
    const now = this.clock.now();
    const pupil = await this.prisma.user.findUniqueOrThrow({ where: { id: pupilId }, select: { name: true, dateOfBirth: true } });
    const minor = !pupil.dateOfBirth || ageInYears(pupil.dateOfBirth, now) < ADULT_AGE;
    const enrollments = await this.prisma.classEnrollment.findMany({
      where: { pupilId, status: 'ACTIVE', class: { status: 'ACTIVE' } },
      include: { class: { select: { id: true, title: true, subject: true, teacher: { select: { id: true, user: { select: { name: true } } } }, sessions: { where: { startAt: { gt: new Date(now.getTime() - 3_600_000) }, status: { in: ['SCHEDULED', 'LOBBY', 'LIVE'] } }, orderBy: { startAt: 'asc' }, take: 1, select: { id: true, startAt: true, status: true } } } } },
    });
    const classIds = enrollments.map((e) => e.classId);
    const [ended, att, hw, subs, lessons] = await Promise.all([
      this.prisma.classSession.findMany({ where: { classId: { in: classIds }, status: 'ENDED', teacherNoShow: false }, orderBy: { startAt: 'desc' }, take: 200, select: { id: true, classId: true, startAt: true, class: { select: { title: true } } } }),
      this.prisma.classAttendance.findMany({ where: { pupilId, session: { classId: { in: classIds } } }, select: { sessionId: true, totalSeconds: true, joinedLate: true } }),
      this.prisma.classHomework.findMany({ where: { classId: { in: classIds } }, select: { id: true, classId: true, title: true, dueAt: true } }),
      this.prisma.classHomeworkSubmission.findMany({ where: { pupilId }, select: { homeworkId: true, score: true, late: true, markedAt: true } }),
      this.prisma.booking.findMany({ where: { studentId: pupilId, status: { in: ['COMPLETED', 'CONFIRMED', 'NO_SHOW_STUDENT', 'CANCELLED'] } }, orderBy: { startAt: 'desc' }, take: 100, select: { id: true, startAt: true, durationMin: true, status: true, teacher: { select: { id: true, user: { select: { name: true } } } }, review: { select: { rating: true } } } }),
    ]);
    const attBy = new Map(att.map((a) => [a.sessionId, a]));
    const subBy = new Map(subs.map((s) => [s.homeworkId, s]));
    const classes = enrollments.map((e) => {
      const sess = ended.filter((s) => s.classId === e.classId);
      const hws = hw.filter((h) => h.classId === e.classId);
      const done = hws.filter((h) => subBy.has(h.id));
      const scores = done.map((h) => subBy.get(h.id)!.score).filter((x): x is number => x !== null);
      return {
        id: e.classId, title: e.class.title, subject: e.class.subject, teacher: { id: e.class.teacher.id, name: e.class.teacher.user.name }, next: e.class.sessions[0] ?? null,
        attendance: { attended: sess.filter((s) => attBy.has(s.id)).length, total: sess.length },
        homework: { total: hws.length, submitted: done.length, avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null },
      };
    });
    const history = [
      ...lessons.filter((l) => l.status !== 'CONFIRMED' || l.startAt < now).map((l) => ({ kind: 'lesson' as const, id: l.id, at: l.startAt, title: '', teacher: l.teacher.user.name, status: l.status, durationMin: l.durationMin, rating: l.review?.rating ?? null })),
      ...ended.slice(0, 60).map((s) => ({ kind: 'class' as const, id: s.id, at: s.startAt, title: s.class.title, teacher: null as string | null, status: attBy.has(s.id) ? 'ATTENDED' : 'MISSED', durationMin: null as number | null, rating: null as number | null })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 60);
    const scored = subs.map((s) => s.score).filter((x): x is number => x !== null);
    return {
      pupil: { id: pupilId, name: displayName(pupil.name, minor) },
      children: actor.role === Role.GUARDIAN ? (await this.prisma.user.findMany({ where: { id: { in: seats } }, select: { id: true, name: true } })).map((c) => ({ id: c.id, name: (c.name ?? '').split(/\s+/)[0] })) : undefined,
      classes,
      upcoming: await this.agendaFor(pupilId, now),
      history,
      stats: {
        lessonsCompleted: lessons.filter((l) => l.status === 'COMPLETED').length,
        classSessionsAttended: att.length,
        homeworkSubmitted: subs.length,
        avgScore: scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null,
      },
    };
  }

  private async agendaFor(pupilId: string, now: Date) {
    const lessons = await this.prisma.booking.findMany({ where: { studentId: pupilId, status: { in: ['REQUESTED', 'CONFIRMED'] }, endAt: { gt: now } }, orderBy: { startAt: 'asc' }, take: 10, select: { id: true, startAt: true, endAt: true, status: true, teacher: { select: { user: { select: { name: true } } } } } });
    const sessions = await this.prisma.classSession.findMany({ where: { startAt: { gt: new Date(now.getTime() - 3_600_000) }, status: { in: ['SCHEDULED', 'LOBBY', 'LIVE'] }, class: { status: 'ACTIVE', enrollments: { some: { pupilId, status: 'ACTIVE' } } } }, orderBy: { startAt: 'asc' }, take: 10, select: { id: true, classId: true, startAt: true, endAt: true, status: true, class: { select: { title: true } } } });
    return [
      ...lessons.map((l) => ({ kind: 'lesson' as const, id: l.id, startAt: l.startAt, endAt: l.endAt, title: '', counterpart: l.teacher.user.name, status: l.status })),
      ...sessions.map((s) => ({ kind: 'class' as const, id: s.id, classId: s.classId, startAt: s.startAt, endAt: s.endAt, title: s.class.title, counterpart: '', status: s.status })),
    ].sort((a, b) => a.startAt.getTime() - b.startAt.getTime()).slice(0, 10);
  }
}
