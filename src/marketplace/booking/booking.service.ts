import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Booking, BookingStatus, Prisma, Role, VerificationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor, ADULT_AGE, ageInYears } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { ClockService } from '../common/clock';
import { marketConfig } from '../common/config';
import { DomainEvents } from '../common/events';
import { LegalService } from '../legal/legal.service';
import { BlocksService } from '../safety/blocks.service';
import { GuardianService } from '../guardian/guardian.service';
import { NotificationsService } from '../notifications/notifications.service';
import { generateSlots } from '../teachers/availability';
import {
  ACTIVE_STATUSES, cancellationOutcome, displayName, earliestNoShowAt, isJoinWindowOpen, joinWindow, nextBookingStatus, priceForDuration, startTimeProblem,
} from './booking-rules';

export type BookingSide = 'student' | 'booker' | 'teacher';

type BookingWithParties = Booking & {
  teacher: { id: string; userId: string; user: { name: string | null } };
  student: { id: string; name: string | null; dateOfBirth: Date | null };
};

const PARTIES = {
  teacher: { select: { id: true, userId: true, user: { select: { name: true } } } },
  student: { select: { id: true, name: true, dateOfBirth: true } },
} as const;

@Injectable()
export class BookingService implements OnModuleInit, OnModuleDestroy {
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private clock: ClockService,
    private guardians: GuardianService,
    private notifications: NotificationsService,
    private events: DomainEvents,
    private legal: LegalService,
    private blocks: BlocksService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.sweepTimer = setInterval(() => void this.expireDue().catch(() => undefined), 60_000);
    this.sweepTimer.unref();
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  // ---------- slotlar ----------

  async slots(profileId: string, from: Date, to: Date, durationMin: number) {
    const cfg = marketConfig();
    if (!cfg.lessonDurationsMin.includes(durationMin)) throw new BadRequestException('Unsupported duration');
    if (!(from < to) || to.getTime() - from.getTime() > 14 * 86_400_000) throw new BadRequestException('Range must be 1..14 days');
    const teacher = await this.verifiedTeacherOrThrow(profileId);
    await this.expireDue();
    const [rules, busyBookings, timeOff] = await Promise.all([
      this.prisma.availabilityRule.findMany({ where: { teacherId: teacher.id } }),
      this.prisma.booking.findMany({ where: { teacherId: teacher.id, status: { in: ACTIVE_STATUSES }, startAt: { lt: to }, endAt: { gt: from } } }),
      this.prisma.teacherTimeOff.findMany({ where: { teacherId: teacher.id, startAt: { lt: to }, endAt: { gt: from } } }),
    ]);
    const now = this.clock.now();
    const slots = generateSlots({
      rules, timezone: teacher.user.timezone, from, to, durationMin,
      busy: [...busyBookings.map((b) => ({ start: b.startAt, end: b.endAt })), ...timeOff.map((o) => ({ start: o.startAt, end: o.endAt }))],
      notBefore: new Date(now.getTime() + cfg.minNoticeMinutes * 60_000),
    });
    const horizon = now.getTime() + cfg.maxAdvanceDays * 86_400_000;
    return { timezone: teacher.user.timezone, durationMin, slots: slots.filter((s) => s.getTime() <= horizon).map((s) => s.toISOString()) };
  }

  // ---------- yaratish ----------

  async create(actor: Actor, input: { teacherId: string; startAt: Date; durationMin: number; studentId?: string }) {
    const cfg = marketConfig();
    const now = this.clock.now();
    if (!cfg.lessonDurationsMin.includes(input.durationMin)) throw new BadRequestException('Unsupported duration');
    const problem = startTimeProblem(input.startAt, now, cfg);
    if (problem) throw new BadRequestException(problem);

    // Kim uchun bron: o'quvchining o'zi (faqat kattalar) yoki bog'langan voyaga yetmagan o'quvchi uchun vasiy
    let studentId: string;
    if (actor.role === Role.STUDENT) {
      if (input.studentId && input.studentId !== actor.id) throw new ForbiddenException('Forbidden');
      if (!actor.ageKnown) throw new ForbiddenException('Date of birth required');
      if (actor.isMinor) throw new ForbiddenException('A guardian must book for minors');
      studentId = actor.id;
    } else if (actor.role === Role.GUARDIAN) {
      if (!input.studentId) throw new BadRequestException('studentId required');
      if (!(await this.guardians.isActiveGuardianOf(actor.id, input.studentId))) throw new NotFoundException('Student not found');
      const st = await this.prisma.user.findUnique({ where: { id: input.studentId }, select: { dateOfBirth: true, status: true } });
      if (!st || st.status !== 'ACTIVE') throw new NotFoundException('Student not found');
      if (!st.dateOfBirth || ageInYears(st.dateOfBirth, now) >= ADULT_AGE) throw new ForbiddenException('Guardians may book only for minors');
      studentId = input.studentId;
    } else {
      throw new ForbiddenException('Forbidden');
    }

    await this.legal.assertTerms(actor);
    const teacher = await this.verifiedTeacherOrThrow(input.teacherId);
    if (teacher.userId === studentId || teacher.userId === actor.id) throw new BadRequestException('Cannot book yourself');
    // Blok: bronlovchi, o'quvchi yoki ularning vasiylari o'qituvchini bloklagan (yoki o'qituvchi ularni) bo'lsa — bron yo'q
    await this.blocks.assertNotBlocked(actor.id, teacher.userId);
    if (studentId !== actor.id) await this.blocks.assertNotBlocked(studentId, teacher.userId);

    await this.expireDue();
    // Oyna aynan darsning o'zi: shu oraliq to'liq mavjud va band emas bo'lsa, slot bor.
    const from = input.startAt;
    const to = new Date(input.startAt.getTime() + input.durationMin * 60_000);
    const [rules, busyBookings, timeOff] = await Promise.all([
      this.prisma.availabilityRule.findMany({ where: { teacherId: teacher.id } }),
      this.prisma.booking.findMany({ where: { teacherId: teacher.id, status: { in: ACTIVE_STATUSES }, startAt: { lt: new Date(input.startAt.getTime() + input.durationMin * 60_000) }, endAt: { gt: input.startAt } } }),
      this.prisma.teacherTimeOff.findMany({ where: { teacherId: teacher.id, startAt: { lt: new Date(input.startAt.getTime() + input.durationMin * 60_000) }, endAt: { gt: input.startAt } } }),
    ]);
    const ok = generateSlots({
      rules, timezone: teacher.user.timezone, from, to, durationMin: input.durationMin,
      busy: [...busyBookings.map((b) => ({ start: b.startAt, end: b.endAt })), ...timeOff.map((o) => ({ start: o.startAt, end: o.endAt }))],
      notBefore: now, stepMin: 15,
    }).some((s) => s.getTime() === input.startAt.getTime());
    if (!ok) throw new ConflictException('Slot not available');

    const instant = teacher.instantBooking;
    const endAt = new Date(input.startAt.getTime() + input.durationMin * 60_000);
    let booking: Booking;
    try {
      booking = await this.prisma.booking.create({
        data: {
          teacherId: teacher.id, studentId, bookedById: actor.id, startAt: input.startAt, endAt, durationMin: input.durationMin,
          priceMinor: priceForDuration(teacher.priceMinor, input.durationMin), currency: teacher.currency,
          status: instant ? BookingStatus.CONFIRMED : BookingStatus.REQUESTED,
          decidedAt: instant ? now : null,
          requestExpiresAt: instant ? null : new Date(Math.min(now.getTime() + cfg.requestExpiryHours * 3_600_000, input.startAt.getTime())),
        },
      });
    } catch (e) {
      this.rethrowConflict(e);
      throw e;
    }
    await this.audit.log(actor, { action: 'booking.create', targetType: 'Booking', targetId: booking.id, metadata: { instant } });
    if (instant) await this.onConfirmed(booking, teacher.userId);
    else await this.notifications.enqueue(teacher.userId, 'booking.requested', { bookingId: booking.id, startAt: booking.startAt.toISOString() });
    return this.get(actor, booking.id);
  }

  // ---------- o'qituvchi qarori ----------

  async accept(actor: Actor, id: string) {
    const b = await this.loadFor(actor, id, ['teacher']);
    if (b.status === 'REQUESTED' && b.requestExpiresAt && b.requestExpiresAt <= this.clock.now()) {
      await this.setStatus(b, 'expire');
      throw new ConflictException('Request expired');
    }
    const next = this.transitionOrThrow(b, 'accept');
    const updated = await this.prisma.booking.update({ where: { id }, data: { status: next, decidedAt: this.clock.now(), requestExpiresAt: null } });
    await this.audit.log(actor, { action: 'booking.accept', targetType: 'Booking', targetId: id });
    await this.onConfirmed(updated, b.teacher.userId);
    return this.get(actor, id);
  }

  async decline(actor: Actor, id: string, reason?: string) {
    const b = await this.loadFor(actor, id, ['teacher']);
    const next = this.transitionOrThrow(b, 'decline');
    await this.prisma.booking.update({ where: { id }, data: { status: next, decidedAt: this.clock.now(), cancelReason: reason?.slice(0, 300) } });
    await this.audit.log(actor, { action: 'booking.decline', targetType: 'Booking', targetId: id });
    await this.notifications.enqueue(b.bookedById, 'booking.declined', { bookingId: id });
    await this.events.emit('booking.declined', { bookingId: id });
    return this.get(actor, id);
  }

  // ---------- bekor qilish ----------

  async cancel(actor: Actor, id: string, reason?: string) {
    const b = await this.loadFor(actor, id, ['student', 'booker', 'teacher']);
    const now = this.clock.now();
    const next = this.transitionOrThrow(b, 'cancel');
    if (b.startAt <= now) throw new ConflictException('Lesson already started; use no-show instead');
    const side = this.sideOf(actor, b) === 'teacher' ? 'TEACHER' : 'STUDENT';
    const outcome = cancellationOutcome(side, b.startAt, now);
    await this.prisma.booking.update({
      where: { id },
      data: {
        status: next, cancelledAt: now, cancelledByUserId: actor.id, cancelledByRole: side === 'TEACHER' ? 'TEACHER' : actor.role,
        cancelReason: reason?.slice(0, 300), lateCancel: outcome.late, proposedStartAt: null, proposedById: null,
      },
    });
    await this.notifications.cancelPendingForBooking(id);
    await this.events.emit('booking.cancelled', { bookingId: id });
    await this.audit.log(actor, { action: 'booking.cancel', targetType: 'Booking', targetId: id, metadata: { late: outcome.late, refundBps: outcome.refundBps } });
    const others = [b.teacher.userId, b.bookedById, b.studentId].filter((u) => u !== actor.id);
    for (const u of new Set(others)) await this.notifications.enqueue(u, 'booking.cancelled', { bookingId: id });
    return { ...(await this.get(actor, id)), refundBps: outcome.refundBps };
  }

  // ---------- ko'chirish (taklif -> qarshi tomon qabul qiladi) ----------

  async proposeReschedule(actor: Actor, id: string, newStart: Date) {
    const cfg = marketConfig();
    const b = await this.loadFor(actor, id, ['student', 'booker', 'teacher']);
    const now = this.clock.now();
    if (b.status !== 'CONFIRMED') throw new ConflictException('Only confirmed lessons can be rescheduled');
    if (b.startAt.getTime() - now.getTime() < cfg.freeCancelHours * 3_600_000) throw new ConflictException('Too close to the lesson start to reschedule');
    const problem = startTimeProblem(newStart, now, cfg);
    if (problem) throw new BadRequestException(problem);
    await this.assertSlotFree(b, newStart);
    await this.prisma.booking.update({ where: { id }, data: { proposedStartAt: newStart, proposedById: actor.id } });
    const other = this.sideOf(actor, b) === 'teacher' ? b.bookedById : b.teacher.userId;
    await this.notifications.enqueue(other, 'booking.reschedule_proposed', { bookingId: id, proposedStartAt: newStart.toISOString() });
    return this.get(actor, id);
  }

  async respondReschedule(actor: Actor, id: string, accept: boolean) {
    const b = await this.loadFor(actor, id, ['student', 'booker', 'teacher']);
    if (!b.proposedStartAt || !b.proposedById) throw new ConflictException('No pending proposal');
    // Faqat QARSHI tomon javob beradi (taklif qiluvchi o'ziga javob bera olmaydi), lekin taklif qiluvchi bekor qila oladi.
    const myTeam = (u: string) => (u === b.teacher.userId ? 'teacher' : 'family');
    const iAmProposerSide = myTeam(actor.id) === myTeam(b.proposedById);
    if (!accept) {
      await this.prisma.booking.update({ where: { id }, data: { proposedStartAt: null, proposedById: null } });
      return this.get(actor, id);
    }
    if (iAmProposerSide) throw new ForbiddenException('The other party must accept');
    const now = this.clock.now();
    if (b.status !== 'CONFIRMED' || b.proposedStartAt.getTime() < now.getTime() + marketConfig().minNoticeMinutes * 60_000) {
      throw new ConflictException('Proposal is no longer valid');
    }
    await this.assertSlotFree(b, b.proposedStartAt);
    const newEnd = new Date(b.proposedStartAt.getTime() + b.durationMin * 60_000);
    try {
      await this.prisma.booking.update({ where: { id }, data: { startAt: b.proposedStartAt, endAt: newEnd, proposedStartAt: null, proposedById: null } });
    } catch (e) {
      this.rethrowConflict(e);
      throw e;
    }
    await this.notifications.cancelPendingForBooking(id);
    await this.events.emit('booking.rescheduled', { bookingId: id });
    await this.scheduleReminders({ ...b, startAt: b.proposedStartAt, endAt: newEnd } as Booking, b.teacher.userId);
    await this.audit.log(actor, { action: 'booking.reschedule', targetType: 'Booking', targetId: id });
    return this.get(actor, id);
  }

  // ---------- no-show / yakunlash ----------

  /** O'qituvchi o'quvchining kelmaganini, o'quvchi/vasiy esa o'qituvchining kelmaganini belgilaydi. */
  async reportNoShow(actor: Actor, id: string) {
    const b = await this.loadFor(actor, id, ['student', 'booker', 'teacher']);
    const side = this.sideOf(actor, b);
    const event = side === 'teacher' ? 'noShowStudent' : 'noShowTeacher';
    const next = this.transitionOrThrow(b, event);
    const now = this.clock.now();
    if (now < earliestNoShowAt(b.startAt)) throw new ConflictException('Too early to report a no-show');
    // Xabar beruvchi o'zi darsga kelgan bo'lishi shart (kelmagan o'qituvchi "o'quvchi kelmadi" deya olmaydi)
    const reporterJoined = await this.prisma.callSession.count({ where: { bookingId: id, userId: actor.id } });
    if (!reporterJoined) throw new ConflictException('You must join the call before reporting a no-show');
    await this.prisma.booking.update({ where: { id }, data: { status: next, noShowMarkedAt: now } });
    await this.audit.log(actor, { action: 'booking.no_show', targetType: 'Booking', targetId: id, metadata: { reportedBy: side, status: next } });
    return this.get(actor, id);
  }

  /** Ichki (tizim) amallar: qo'ng'iroq moduli va sweep chaqiradi. */
  async systemTransition(id: string, event: 'complete' | 'noShowStudent' | 'noShowTeacher' | 'fail', extra: Prisma.BookingUpdateInput = {}) {
    const b = await this.prisma.booking.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Not found');
    const next = nextBookingStatus(b.status, event);
    if (!next) throw new ConflictException(`Cannot ${event} from ${b.status}`);
    const now = this.clock.now();
    const updated = await this.prisma.booking.update({
      where: { id },
      data: { status: next, ...(event === 'complete' ? { completedAt: now } : {}), ...(event.startsWith('noShow') ? { noShowMarkedAt: now } : {}), ...extra },
    });
    await this.audit.log('SYSTEM', { action: `booking.${event}`, targetType: 'Booking', targetId: id });
    return updated;
  }

  // ---------- o'qish ----------

  async get(actor: Actor, id: string) {
    await this.expireDue();
    const b = await this.loadFor(actor, id, ['student', 'booker', 'teacher'], true);
    return this.view(actor, b);
  }

  async list(actor: Actor, from: Date, to: Date, statuses?: BookingStatus[]) {
    if (!(from < to) || to.getTime() - from.getTime() > 93 * 86_400_000) throw new BadRequestException('Range must be up to 93 days');
    await this.expireDue();
    const linked = actor.role === Role.GUARDIAN ? await this.guardians.linkedStudentIds(actor.id) : [];
    const rows = await this.prisma.booking.findMany({
      where: {
        startAt: { gte: from, lt: to },
        ...(statuses?.length ? { status: { in: statuses } } : {}),
        OR: [{ studentId: actor.id }, { bookedById: actor.id }, { teacher: { userId: actor.id } }, ...(linked.length ? [{ studentId: { in: linked } }] : [])],
      },
      include: PARTIES,
      orderBy: { startAt: 'asc' },
      take: 500,
    });
    return rows.map((b) => this.view(actor, b as BookingWithParties));
  }

  /** Sana oynasidagi bo'sh-band kalendar: o'qituvchi uchun o'z bronlari. */
  // (list() o'qituvchi uchun ham ishlaydi — alohida kalendar endpoint kerak emas)

  // ---------- sweep ----------

  /** Muddati o'tgan so'rovlarni EXPIRED qiladi. Har bir o'qishdan oldin va davriy ravishda chaqiriladi. */
  async expireDue(): Promise<number> {
    const now = this.clock.now();
    const due = await this.prisma.booking.findMany({ where: { status: 'REQUESTED', requestExpiresAt: { lte: now } }, select: { id: true, bookedById: true } });
    for (const d of due) {
      const r = await this.prisma.booking.updateMany({ where: { id: d.id, status: 'REQUESTED' }, data: { status: 'EXPIRED' } });
      if (r.count) {
        await this.notifications.enqueue(d.bookedById, 'booking.expired', { bookingId: d.id });
        await this.events.emit('booking.expired', { bookingId: d.id });
      }
    }
    return due.length;
  }

  // ---------- ichki yordamchilar ----------

  private async verifiedTeacherOrThrow(profileId: string) {
    const t = await this.prisma.teacherProfile.findFirst({
      where: { id: profileId, verificationStatus: VerificationStatus.VERIFIED, user: { status: 'ACTIVE' } },
      include: { user: { select: { timezone: true } } },
    });
    if (!t) throw new NotFoundException('Teacher not found');
    return t;
  }

  sideOf(actor: Actor, b: { studentId: string; bookedById: string; teacher: { userId: string } }): BookingSide | null {
    if (b.teacher.userId === actor.id) return 'teacher';
    if (b.studentId === actor.id) return 'student';
    if (b.bookedById === actor.id) return 'booker';
    return null;
  }

  /** Bronni yuklaydi va aktor ruxsat etilgan tomonlardan biri bo'lmasa 404 qaytaradi (mavjudlikni oshkor qilmaydi). */
  private async loadFor(actor: Actor, id: string, sides: BookingSide[], allowGuardian = false): Promise<BookingWithParties> {
    const b = (await this.prisma.booking.findUnique({ where: { id }, include: PARTIES })) as BookingWithParties | null;
    if (!b) throw new NotFoundException('Not found');
    let side = this.sideOf(actor, b);
    if (!side && allowGuardian && actor.role === Role.GUARDIAN && (await this.guardians.isActiveGuardianOf(actor.id, b.studentId))) side = 'booker';
    if (!side || !sides.includes(side)) throw new NotFoundException('Not found');
    return b;
  }

  private transitionOrThrow(b: Booking, event: Parameters<typeof nextBookingStatus>[1]): BookingStatus {
    const next = nextBookingStatus(b.status, event);
    if (!next) throw new ConflictException(`Cannot ${event} from ${b.status}`);
    return next;
  }

  private async setStatus(b: Booking, event: 'expire') {
    const next = this.transitionOrThrow(b, event);
    await this.prisma.booking.update({ where: { id: b.id }, data: { status: next } });
  }

  private rethrowConflict(e: unknown): void {
    const msg = String((e as any)?.message ?? '');
    if (msg.includes('booking_no_teacher_overlap') || msg.includes('booking_no_student_overlap') || msg.includes('23P01') || msg.includes('exclusion')) {
      throw new ConflictException('Slot not available');
    }
  }

  private async assertSlotFree(b: BookingWithParties, newStart: Date) {
    const teacher = await this.prisma.teacherProfile.findUniqueOrThrow({ where: { id: b.teacherId }, include: { user: { select: { timezone: true } } } });
    const endAt = new Date(newStart.getTime() + b.durationMin * 60_000);
    const [rules, busy, timeOff] = await Promise.all([
      this.prisma.availabilityRule.findMany({ where: { teacherId: b.teacherId } }),
      this.prisma.booking.findMany({ where: { teacherId: b.teacherId, id: { not: b.id }, status: { in: ACTIVE_STATUSES }, startAt: { lt: endAt }, endAt: { gt: newStart } } }),
      this.prisma.teacherTimeOff.findMany({ where: { teacherId: b.teacherId, startAt: { lt: endAt }, endAt: { gt: newStart } } }),
    ]);
    const ok = generateSlots({
      rules, timezone: teacher.user.timezone, from: newStart, to: endAt, durationMin: b.durationMin,
      busy: [...busy.map((x) => ({ start: x.startAt, end: x.endAt })), ...timeOff.map((o) => ({ start: o.startAt, end: o.endAt }))],
      notBefore: this.clock.now(), stepMin: 15,
    }).some((s) => s.getTime() === newStart.getTime());
    if (!ok) throw new ConflictException('Slot not available');
  }

  private async onConfirmed(b: Booking, teacherUserId: string) {
    await this.scheduleReminders(b, teacherUserId);
    for (const u of new Set([b.bookedById, b.studentId, teacherUserId])) {
      await this.notifications.enqueue(u, 'booking.confirmed', { bookingId: b.id, startAt: b.startAt.toISOString() });
    }
  }

  /** 24 soat va 15 daqiqa oldin eslatma (dedupeKey qayta rejalashtirishda dublikatni oldini oladi). */
  private async scheduleReminders(b: Booking, teacherUserId: string) {
    const now = this.clock.now();
    for (const [label, minutes] of [['24h', 24 * 60], ['15m', 15]] as const) {
      const dueAt = new Date(b.startAt.getTime() - minutes * 60_000);
      if (dueAt <= now) continue;
      for (const u of new Set([b.bookedById, b.studentId, teacherUserId])) {
        await this.notifications.enqueue(u, 'booking.reminder', { bookingId: b.id, startAt: b.startAt.toISOString(), when: label }, {
          dueAt, dedupeKey: `booking:${b.id}:reminder:${label}:${b.startAt.getTime()}`,
        });
      }
    }
  }

  private view(actor: Actor, b: BookingWithParties) {
    const side = this.sideOf(actor, b) ?? 'booker'; // vasiy (bog'langan) booker sifatida ko'rinadi
    const cfg = marketConfig();
    const now = this.clock.now();
    const w = joinWindow(b.startAt, b.endAt, cfg);
    const studentIsMinor = b.student.dateOfBirth ? ageInYears(b.student.dateOfBirth, now) < ADULT_AGE : false;
    return {
      id: b.id,
      status: b.status,
      myRole: side,
      startAt: b.startAt,
      endAt: b.endAt,
      durationMin: b.durationMin,
      priceMinor: b.priceMinor,
      currency: b.currency,
      teacher: { id: b.teacher.id, name: b.teacher.user.name },
      // O'qituvchiga o'quvchining faqat ko'rinadigan ismi beriladi (voyaga yetmaganlar uchun qisqartirilgan); email/id berilmaydi
      student: side === 'teacher' ? { name: displayName(b.student.name, studentIsMinor) } : { id: b.student.id, name: b.student.name },
      joinWindow: { opensAt: w.opensAt, closesAt: w.closesAt },
      canJoinNow: b.status === 'CONFIRMED' && isJoinWindowOpen(b.startAt, b.endAt, now, cfg),
      requestExpiresAt: b.requestExpiresAt,
      cancel: b.status === 'CANCELLED' ? { by: b.cancelledByRole, late: b.lateCancel, reason: b.cancelReason, at: b.cancelledAt } : null,
      reschedule: b.proposedStartAt ? { proposedStartAt: b.proposedStartAt, byMe: b.proposedById === actor.id } : null,
      lateCancelPolicy: { freeCancelHours: cfg.freeCancelHours },
    };
  }
}
