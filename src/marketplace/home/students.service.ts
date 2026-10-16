import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DirectPaymentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor, ADULT_AGE, ageInYears } from '../common/actor';
import { ClockService } from '../common/clock';
import { displayName } from '../booking/booking-rules';

const OWED: DirectPaymentStatus[] = ['UNPAID', 'NOT_RECEIVED'];
const DAY = 86_400_000;

/** O'qituvchining o'quvchilari: har biri bo'yicha keyingi dars, oxirgi faollik, uy vazifasi, to'lov belgisi va tezkor xabar. Faqat o'z o'quvchilari. */
@Injectable()
export class StudentsService {
  constructor(private prisma: PrismaService, private clock: ClockService) {}

  private async teacherId(actor: Actor): Promise<string> {
    const t = await this.prisma.teacherProfile.findFirst({ where: { userId: actor.id }, select: { id: true } });
    if (!t) throw new ForbiddenException('Teachers only');
    return t.id;
  }
  private nameOf(u: { name: string | null; dateOfBirth: Date | null }, now: Date) {
    const minor = !u.dateOfBirth || ageInYears(u.dateOfBirth, now) < ADULT_AGE;
    return { name: displayName(u.name, minor), minor };
  }

  async list(actor: Actor) {
    const teacherId = await this.teacherId(actor);
    const now = this.clock.now();
    const [bookings, enrollments, homework, classPays, sessions] = await Promise.all([
      this.prisma.booking.findMany({
        where: { teacherId, status: { in: ['REQUESTED', 'CONFIRMED', 'COMPLETED', 'NO_SHOW_STUDENT'] } }, orderBy: { startAt: 'desc' }, take: 3000,
        select: { id: true, studentId: true, status: true, startAt: true, createdAt: true, isTrial: true, priceMinor: true, student: { select: { name: true, dateOfBirth: true } }, directPayment: { select: { status: true, amountMinor: true } } },
      }),
      this.prisma.classEnrollment.findMany({ where: { status: 'ACTIVE', class: { teacherId, status: 'ACTIVE' } }, take: 3000, select: { pupilId: true, createdAt: true, class: { select: { id: true, title: true } }, pupil: { select: { name: true, dateOfBirth: true } } } }),
      this.prisma.classHomework.findMany({ where: { class: { teacherId } }, take: 1000, select: { id: true, classId: true, submissions: { select: { pupilId: true, score: true, markedAt: true } } } }),
      this.prisma.classPayment.findMany({ where: { class: { teacherId }, status: { in: OWED } }, take: 3000, select: { pupilId: true, amountMinor: true } }),
      this.prisma.classSession.findMany({ where: { class: { teacherId, status: 'ACTIVE' }, startAt: { gt: new Date(now.getTime() - 3_600_000) }, status: { in: ['SCHEDULED', 'LOBBY', 'LIVE'] } }, orderBy: { startAt: 'asc' }, take: 500, select: { classId: true, startAt: true } }),
    ]);
    const nextByClass = new Map<string, Date>();
    for (const s of sessions) if (!nextByClass.has(s.classId)) nextByClass.set(s.classId, s.startAt);

    interface Row { pupilId: string; name: string; minor: boolean; since: Date | null; lessons: number; nextAt: Date | null; lastAt: Date | null; classes: { id: string; title: string }[]; chatBookingId: string | null; owedCount: number; owedMinor: number; hwAssigned: number; hwSubmitted: number; hwToMark: number; scores: number[] }
    const rows = new Map<string, Row>();
    const row = (id: string, u: { name: string | null; dateOfBirth: Date | null }): Row => {
      let r = rows.get(id);
      if (!r) {
        r = { pupilId: id, ...this.nameOf(u, now), since: null, lessons: 0, nextAt: null, lastAt: null, classes: [], chatBookingId: null, owedCount: 0, owedMinor: 0, hwAssigned: 0, hwSubmitted: 0, hwToMark: 0, scores: [] };
        rows.set(id, r);
      }
      return r;
    };
    for (const b of bookings) {
      const r = row(b.studentId, b.student);
      if (!r.since || b.createdAt < r.since) r.since = b.createdAt;
      r.chatBookingId ??= b.id; // eng oxirgi bron (startAt desc)
      if (b.status === 'COMPLETED') {
        r.lessons++;
        if (!r.lastAt || b.startAt > r.lastAt) r.lastAt = b.startAt;
      }
      if (b.status === 'CONFIRMED' && b.startAt > now && (!r.nextAt || b.startAt < r.nextAt)) r.nextAt = b.startAt;
      if (!b.isTrial && (b.status === 'COMPLETED' || b.status === 'NO_SHOW_STUDENT') && b.directPayment && OWED.includes(b.directPayment.status)) {
        r.owedCount++;
        r.owedMinor += Number(b.directPayment.amountMinor);
      }
    }
    for (const e of enrollments) {
      const r = row(e.pupilId, e.pupil);
      r.classes.push(e.class);
      if (!r.since || e.createdAt < r.since) r.since = e.createdAt;
      const n = nextByClass.get(e.class.id);
      if (n && (!r.nextAt || n < r.nextAt)) r.nextAt = n;
    }
    const classOf = (pupilId: string) => new Set(rows.get(pupilId)?.classes.map((c) => c.id));
    for (const h of homework) {
      for (const r of rows.values()) {
        if (!classOf(r.pupilId).has(h.classId)) continue;
        r.hwAssigned++;
        const s = h.submissions.find((x) => x.pupilId === r.pupilId);
        if (s) {
          r.hwSubmitted++;
          if (!s.markedAt) r.hwToMark++;
          if (s.score !== null) r.scores.push(s.score);
        }
      }
    }
    for (const p of classPays) {
      const r = rows.get(p.pupilId);
      if (r) {
        r.owedCount++;
        r.owedMinor += Number(p.amountMinor);
      }
    }
    return [...rows.values()]
      .map((r) => ({
        pupilId: r.pupilId, name: r.name, minor: r.minor, since: r.since, lessonsCompleted: r.lessons, nextAt: r.nextAt, lastLessonAt: r.lastAt, classes: r.classes, chatBookingId: r.chatBookingId,
        homework: { assigned: r.hwAssigned, submitted: r.hwSubmitted, toMark: r.hwToMark, avgScore: r.scores.length ? Math.round(r.scores.reduce((a, b) => a + b, 0) / r.scores.length) : null },
        payment: { owedCount: r.owedCount, owedMinor: r.owedMinor },
        attention: r.owedCount > 0 || r.hwToMark > 0 || (r.lastAt !== null && now.getTime() - r.lastAt.getTime() > 30 * DAY && !r.nextAt),
      }))
      .sort((a, b) => Number(b.attention) - Number(a.attention) || (a.name ?? '').localeCompare(b.name ?? ''))
      .slice(0, 300);
  }

  /** O'qituvchi o'quvchini @nomi bo'yicha topadi (kamida 3 belgi, nom boshidan): faqat ko'rinadigan ism va @nom chiqadi, kontakt ma'lumotlari yo'q. */
  async findPupils(actor: Actor, qIn: string) {
    await this.teacherId(actor);
    const q = qIn.trim().replace(/^@/, '').toLowerCase().slice(0, 20);
    if (q.length < 3) return [];
    const rows = await this.prisma.user.findMany({ where: { role: 'STUDENT', status: 'ACTIVE', username: { startsWith: q } }, orderBy: { username: 'asc' }, take: 10, select: { name: true, username: true, dateOfBirth: true } });
    const now = this.clock.now();
    return rows.map((x) => ({ username: x.username, name: this.nameOf(x, now).name }));
  }

  async detail(actor: Actor, pupilId: string) {
    const teacherId = await this.teacherId(actor);
    const now = this.clock.now();
    const [bookings, enrollments] = await Promise.all([
      this.prisma.booking.findMany({ where: { teacherId, studentId: pupilId, status: { in: ['REQUESTED', 'CONFIRMED', 'COMPLETED', 'NO_SHOW_STUDENT', 'CANCELLED'] } }, orderBy: { startAt: 'desc' }, take: 100, select: { id: true, startAt: true, durationMin: true, status: true, isTrial: true, priceMinor: true, directPayment: { select: { status: true } } } }),
      this.prisma.classEnrollment.findMany({ where: { pupilId, class: { teacherId } }, select: { status: true, classId: true, createdAt: true, class: { select: { id: true, title: true, subject: true } } } }),
    ]);
    if (!bookings.length && !enrollments.length) throw new NotFoundException('Student not found');
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: pupilId }, select: { name: true, dateOfBirth: true } });
    const classIds = enrollments.map((e) => e.classId);
    const [sessions, att, hw, pays] = await Promise.all([
      this.prisma.classSession.findMany({ where: { classId: { in: classIds }, status: 'ENDED', teacherNoShow: false }, select: { id: true, classId: true } }),
      this.prisma.classAttendance.findMany({ where: { pupilId, session: { classId: { in: classIds } } }, select: { sessionId: true, joinedLate: true } }),
      this.prisma.classHomework.findMany({ where: { classId: { in: classIds } }, orderBy: { dueAt: 'desc' }, take: 50, select: { id: true, classId: true, title: true, dueAt: true, submissions: { where: { pupilId }, select: { score: true, late: true, markedAt: true } } } }),
      this.prisma.classPayment.findMany({ where: { pupilId, classId: { in: classIds } }, select: { status: true, amountMinor: true } }),
    ]);
    const attended = new Set(att.map((a) => a.sessionId));
    return {
      pupil: { id: pupilId, ...this.nameOf(u, now) },
      lessons: bookings.map((b) => ({ id: b.id, startAt: b.startAt, durationMin: b.durationMin, status: b.status, isTrial: b.isTrial, priceMinor: b.priceMinor, payment: b.directPayment?.status ?? null })),
      classes: enrollments.map((e) => {
        const ss = sessions.filter((s) => s.classId === e.classId);
        return { id: e.class.id, title: e.class.title, subject: e.class.subject, since: e.createdAt, enrolled: e.status === 'ACTIVE', attendance: { attended: ss.filter((s) => attended.has(s.id)).length, total: ss.length, late: att.filter((a) => a.joinedLate && ss.some((s) => s.id === a.sessionId)).length } };
      }),
      homework: hw.map((h) => ({ id: h.id, classId: h.classId, title: h.title, dueAt: h.dueAt, submitted: h.submissions.length > 0, late: h.submissions[0]?.late ?? false, score: h.submissions[0]?.score ?? null, marked: !!h.submissions[0]?.markedAt })),
      payments: {
        lessonsOwed: bookings.filter((b) => !b.isTrial && b.directPayment && OWED.includes(b.directPayment.status) && (b.status === 'COMPLETED' || b.status === 'NO_SHOW_STUDENT')).length,
        classOwed: pays.filter((p) => OWED.includes(p.status)).length,
        confirmed: bookings.filter((b) => b.directPayment?.status === 'TEACHER_CONFIRMED').length + pays.filter((p) => p.status === 'TEACHER_CONFIRMED').length,
      },
      chatBookingId: bookings[0]?.id ?? null,
    };
  }
}
