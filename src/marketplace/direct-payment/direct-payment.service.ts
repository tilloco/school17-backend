import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Booking, DirectPayment, DirectPaymentStatus, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { ClockService } from '../common/clock';
import { DomainEvents } from '../common/events';
import { GuardianService } from '../guardian/guardian.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ADULT_AGE, ageInYears } from '../common/actor';
import { displayName } from '../booking/booking-rules';
import { monthRange, toCsv } from './csv';
import { DirectEvent, nextDirectStatus, PAYABLE_BOOKING_STATUSES } from './direct-payment-rules';

type Side = 'teacher' | 'pupil';
type Full = Booking & { teacher: { userId: string; paymentTiming: string; user: { name: string | null } } };

@Injectable()
export class DirectPaymentService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private clock: ClockService,
    private audit: AuditService,
    private guardians: GuardianService,
    private notifications: NotificationsService,
    private events: DomainEvents,
  ) {}

  onModuleInit() {
    this.events.on('booking.confirmed', ({ bookingId }) => this.ensure(bookingId).then(() => undefined));
    this.events.on('booking.cancelled', ({ bookingId }) => this.systemWaive(bookingId, 'cancelled'));
    this.events.on('booking.noshow', ({ bookingId, kind }) => (kind === 'NO_SHOW_TEACHER' ? this.systemWaive(bookingId, 'teacher_no_show') : undefined));
    this.events.on('booking.failed', ({ bookingId }) => this.systemWaive(bookingId, 'failed'));
  }

  // ---------- yaratish / avtomatik holatlar ----------

  /** Qabul qilingan, sinov bo'lmagan dars uchun yozuv (narx nusxasi bilan). Takror chaqirish xavfsiz. */
  async ensure(bookingId: string): Promise<DirectPayment | null> {
    const b = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!b || b.isTrial || !(PAYABLE_BOOKING_STATUSES as readonly string[]).includes(b.status)) return null;
    const existing = await this.prisma.directPayment.findUnique({ where: { bookingId } });
    if (existing) return existing;
    try {
      return await this.prisma.directPayment.create({ data: { bookingId, amountMinor: BigInt(b.priceMinor) } });
    } catch (e: any) {
      if (e?.code === 'P2002') return this.prisma.directPayment.findUnique({ where: { bookingId } });
      throw e;
    }
  }

  private async systemWaive(bookingId: string, reason: string) {
    const dp = await this.prisma.directPayment.findUnique({ where: { bookingId } });
    if (!dp) return;
    const next = nextDirectStatus(dp.status, 'system_waive');
    if (!next) return;
    const r = await this.prisma.directPayment.updateMany({
      where: { id: dp.id, status: dp.status },
      data: { status: next, waivedAt: this.clock.now(), waivedFrom: dp.status, waivedReason: reason },
    });
    if (r.count) await this.audit.log('SYSTEM', { action: 'directpay.waived', targetType: 'Booking', targetId: bookingId, metadata: { reason, from: dp.status } });
  }

  // ---------- kirish huquqi ----------

  private async load(actor: Actor, bookingId: string): Promise<{ b: Full; side: Side }> {
    const b = (await this.prisma.booking.findUnique({ where: { id: bookingId }, include: { teacher: { select: { userId: true, paymentTiming: true, user: { select: { name: true } } } } } })) as Full | null;
    if (!b) throw new NotFoundException('Not found');
    if (b.teacher.userId === actor.id) return { b, side: 'teacher' };
    if (b.studentId === actor.id || b.bookedById === actor.id) return { b, side: 'pupil' };
    if (actor.role === Role.GUARDIAN && (await this.guardians.isActiveGuardianOf(actor.id, b.studentId))) return { b, side: 'pupil' };
    throw new NotFoundException('Not found'); // begona uchun mavjudlik oshkor qilinmaydi
  }

  private async pupilRecipients(b: Booking): Promise<string[]> {
    return [...new Set([b.bookedById, b.studentId])];
  }

  // ---------- o'qish ----------

  async get(actor: Actor, bookingId: string) {
    const { b, side } = await this.load(actor, bookingId);
    if (b.isTrial) return { bookingId, trial: true, status: null, note: 'Trial lessons are free' };
    const dp = (await this.ensure(bookingId)) ?? (await this.prisma.directPayment.findUnique({ where: { bookingId } }));
    if (!dp) return { bookingId, trial: false, status: null, note: 'Payment details appear after the teacher accepts the lesson' };
    return this.view(dp, b, side);
  }

  private view(dp: DirectPayment, b: Full, side: Side) {
    const s = dp.status;
    return {
      bookingId: dp.bookingId, trial: false, side, status: s, amountMinor: Number(dp.amountMinor), currency: b.currency,
      paymentTiming: b.teacher.paymentTiming, teacher: { id: b.teacherId, name: b.teacher.user.name },
      pupilMarkedAt: dp.pupilMarkedAt, teacherConfirmedAt: dp.teacherConfirmedAt, notReceivedAt: dp.notReceivedAt, waivedAt: dp.waivedAt, waivedReason: dp.waivedReason,
      hasProof: !!dp.proofFileId, proofFileId: dp.proofFileId,
      // Tugmalar holat mashinasi bilan bir xil manbadan
      canMarkPaid: side === 'pupil' && nextDirectStatus(s, 'pupil_paid') !== null,
      canConfirm: side === 'teacher' && nextDirectStatus(s, 'teacher_received') !== null,
      canMarkNotReceived: side === 'teacher' && nextDirectStatus(s, 'teacher_not_received') !== null,
      canWaive: side === 'teacher' && nextDirectStatus(s, 'teacher_waive') !== null,
    };
  }

  /** O'qituvchi uchun qisqa hisobot (A4 kengaytiradi): to'lanmagan o'tgan darslar va tasdiq kutayotganlar. */
  async teacherSummary(actor: Actor) {
    if (actor.role !== Role.TEACHER) throw new ForbiddenException('Forbidden');
    const mine = { teacher: { userId: actor.id }, isTrial: false };
    const [unpaid, awaiting] = await Promise.all([
      this.prisma.directPayment.count({ where: { status: { in: ['UNPAID', 'NOT_RECEIVED'] }, booking: { ...mine, status: { in: ['COMPLETED', 'NO_SHOW_STUDENT'] } } } }),
      this.prisma.directPayment.count({ where: { status: 'PUPIL_MARKED_PAID', booking: mine } }),
    ]);
    return { unpaidLessons: unpaid, awaitingConfirmation: awaiting };
  }

  // ---------- A4: o'qituvchi pul doskasi ----------

  private pupilName(u: { name: string | null; dateOfBirth: Date | null }): string {
    const minor = u.dateOfBirth ? ageInYears(u.dateOfBirth, this.clock.now()) < ADULT_AGE : true;
    return displayName(u.name, minor);
  }

  /** "Kim menga qarzdor": o'quvchilar bo'yicha guruhlangan to'lanmagan o'tgan darslar. O'quvchi id/email chiqmaydi. */
  async owed(actor: Actor) {
    this.requireTeacher(actor);
    const rows = await this.prisma.directPayment.findMany({
      where: { status: { in: ['UNPAID', 'NOT_RECEIVED'] }, booking: { teacher: { userId: actor.id }, isTrial: false, status: { in: ['COMPLETED', 'NO_SHOW_STUDENT'] } } },
      orderBy: { booking: { startAt: 'asc' } },
      include: { booking: { include: { student: { select: { id: true, name: true, dateOfBirth: true } } } } },
      take: 1000,
    });
    const cutoff = this.clock.now().getTime() - 24 * 3_600_000;
    const groups = new Map<string, { pupilName: string; totalMinor: number; lessons: { bookingId: string; startAt: Date; amountMinor: number; status: string }[]; lastRemindedAt: Date | null }>();
    for (const r of rows) {
      const sid = r.booking.studentId;
      const g = groups.get(sid) ?? { pupilName: this.pupilName(r.booking.student), totalMinor: 0, lessons: [], lastRemindedAt: null };
      g.totalMinor += Number(r.amountMinor);
      g.lessons.push({ bookingId: r.bookingId, startAt: r.booking.startAt, amountMinor: Number(r.amountMinor), status: r.status });
      if (r.lastRemindedAt && (!g.lastRemindedAt || r.lastRemindedAt > g.lastRemindedAt)) g.lastRemindedAt = r.lastRemindedAt;
      groups.set(sid, g);
    }
    return [...groups.values()].map((g) => ({
      pupilName: g.pupilName, count: g.lessons.length, totalMinor: g.totalMinor, lessons: g.lessons, lastRemindedAt: g.lastRemindedAt,
      remindBookingId: g.lessons[0].bookingId, canRemind: !g.lastRemindedAt || g.lastRemindedAt.getTime() < cutoff,
    }));
  }

  /** Eslatma: bir o'quvchiga 24 soatda 1 marta. Xabarda karta raqami YO'Q (shablon umumiy, faqat bookingId). */
  async remind(actor: Actor, bookingId: string) {
    this.requireTeacher(actor);
    const b = await this.prisma.booking.findFirst({ where: { id: bookingId, teacher: { userId: actor.id }, isTrial: false } });
    if (!b) throw new NotFoundException('Not found');
    const unpaid = await this.prisma.directPayment.findMany({
      where: { status: { in: ['UNPAID', 'NOT_RECEIVED'] }, booking: { teacher: { userId: actor.id }, studentId: b.studentId, isTrial: false, status: { in: ['COMPLETED', 'NO_SHOW_STUDENT'] } } },
      orderBy: { booking: { startAt: 'asc' } },
    });
    if (unpaid.length === 0) throw new ConflictException({ message: 'Nothing is owed', code: 'NOTHING_OWED' });
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - 24 * 3_600_000);
    // Poyga holatiga chidamli: eng eski yozuvda "oxirgi eslatma" shartli yangilanadi, 0 bo'lsa limit
    const anchor = await this.prisma.directPayment.findMany({ where: { booking: { teacher: { userId: actor.id }, studentId: b.studentId } }, select: { lastRemindedAt: true } });
    if (anchor.some((a) => a.lastRemindedAt && a.lastRemindedAt > cutoff)) throw new HttpException({ message: 'You can remind a pupil once a day', code: 'REMIND_LIMIT' }, 429);
    const claimed = await this.prisma.directPayment.updateMany({ where: { id: unpaid[0].id, OR: [{ lastRemindedAt: null }, { lastRemindedAt: { lt: cutoff } }] }, data: { lastRemindedAt: now } });
    if (claimed.count === 0) throw new HttpException({ message: 'You can remind a pupil once a day', code: 'REMIND_LIMIT' }, 429);
    await this.prisma.directPayment.updateMany({ where: { id: { in: unpaid.map((u) => u.id) } }, data: { lastRemindedAt: now } });
    for (const u of await this.pupilRecipients(b)) await this.notifications.enqueue(u, 'directpay.reminder', { bookingId: unpaid[0].bookingId }, { dedupeKey: `dp-remind:${unpaid[0].id}:${now.toISOString().slice(0, 10)}:${u}` });
    await this.audit.log(actor, { action: 'directpay.remind', targetType: 'Booking', targetId: bookingId, metadata: { lessons: unpaid.length } });
    return { reminded: unpaid.length };
  }

  /** Oylik daromad: o'qituvchi "oldim" deb tasdiqlagan darslar (oy chegaralari o'qituvchining vaqt zonasida). */
  async income(actor: Actor, month?: string) {
    this.requireTeacher(actor);
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { timezone: true } });
    const now = this.clock.now();
    const key = month ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const range = monthRange(key, u.timezone);
    if (!range) throw new BadRequestException('month must be YYYY-MM');
    const mine = { teacher: { userId: actor.id }, isTrial: false };
    const [confirmed, awaiting, unpaid] = await Promise.all([
      this.prisma.directPayment.aggregate({ where: { status: 'TEACHER_CONFIRMED', teacherConfirmedAt: { gte: range.from, lt: range.to }, booking: mine }, _sum: { amountMinor: true }, _count: { _all: true } }),
      this.prisma.directPayment.count({ where: { status: 'PUPIL_MARKED_PAID', booking: mine } }),
      this.prisma.directPayment.count({ where: { status: { in: ['UNPAID', 'NOT_RECEIVED'] }, booking: { ...mine, status: { in: ['COMPLETED', 'NO_SHOW_STUDENT'] } } } }),
    ]);
    return { month: key, timezone: u.timezone, confirmedMinor: Number(confirmed._sum.amountMinor ?? 0n), confirmedCount: confirmed._count._all, awaitingConfirmation: awaiting, unpaidLessons: unpaid, note: 'Based on marks made by you and your pupils; School17 does not check payments.' };
  }

  /** O'qituvchining O'Z yozuvlari CSV (formula inyeksiyasidan himoyalangan). */
  async exportCsv(actor: Actor, from: Date, to: Date) {
    this.requireTeacher(actor);
    if (!(from < to) || to.getTime() - from.getTime() > 400 * 86_400_000) throw new BadRequestException('Range must be up to 400 days');
    const rows = await this.prisma.directPayment.findMany({
      where: { booking: { teacher: { userId: actor.id }, isTrial: false, startAt: { gte: from, lt: to } } },
      orderBy: { booking: { startAt: 'asc' } }, take: 5000,
      include: { booking: { include: { student: { select: { name: true, dateOfBirth: true } } } } },
    });
    return toCsv(['date_utc', 'pupil', 'minutes', 'amount_uzs', 'lesson_status', 'payment_mark', 'confirmed_at_utc'],
      rows.map((r) => [r.booking.startAt.toISOString(), this.pupilName(r.booking.student), r.booking.durationMin, Math.round(Number(r.amountMinor) / 100), r.booking.status, r.status, r.teacherConfirmedAt?.toISOString() ?? '']));
  }

  /** O'quvchi/vasiy: o'z to'lov belgilari ro'yxati. */
  async minePupil(actor: Actor) {
    const linked = actor.role === Role.GUARDIAN ? await this.guardians.linkedStudentIds(actor.id) : [];
    const rows = await this.prisma.directPayment.findMany({
      where: { booking: { isTrial: false, OR: [{ studentId: actor.id }, { bookedById: actor.id }, ...(linked.length ? [{ studentId: { in: linked } }] : [])] } },
      orderBy: { createdAt: 'desc' }, take: 200,
      include: { booking: { select: { id: true, startAt: true, durationMin: true, status: true, teacher: { select: { id: true, paymentTiming: true, user: { select: { name: true } } } } } } },
    });
    return rows.map((r) => ({
      bookingId: r.bookingId, startAt: r.booking.startAt, durationMin: r.booking.durationMin, lessonStatus: r.booking.status, status: r.status, amountMinor: Number(r.amountMinor),
      teacher: { id: r.booking.teacher.id, name: r.booking.teacher.user.name }, paymentTiming: r.booking.teacher.paymentTiming,
    }));
  }

  private requireTeacher(actor: Actor) {
    if (actor.role !== Role.TEACHER) throw new ForbiddenException('Forbidden');
  }

  // ---------- o'zgartirish ----------

  private async transition(actor: Actor, bookingId: string, side: Side, event: DirectEvent, extra: Partial<DirectPayment> = {}, reason?: string) {
    const { b, side: mySide } = await this.load(actor, bookingId);
    if (mySide !== side) throw new ForbiddenException('Forbidden');
    if (b.isTrial) throw new ConflictException({ message: 'Trial lessons are free', code: 'TRIAL_FREE' });
    if (!(PAYABLE_BOOKING_STATUSES as readonly string[]).includes(b.status) && b.status !== 'FAILED' && b.status !== 'NO_SHOW_TEACHER' && b.status !== 'CANCELLED') {
      throw new ConflictException({ message: 'The lesson is not accepted yet', code: 'NOT_ACCEPTED' });
    }
    const dp = await this.ensure(bookingId);
    if (!dp) throw new ConflictException({ message: 'The lesson is not accepted yet', code: 'NOT_ACCEPTED' });
    const next = nextDirectStatus(dp.status, event);
    if (!next) throw new ConflictException({ message: `Not allowed from ${dp.status}`, code: 'INVALID_TRANSITION', status: dp.status });
    const now = this.clock.now();
    const stamp: Partial<Record<DirectEvent, object>> = {
      pupil_paid: { pupilMarkedAt: now }, teacher_received: { teacherConfirmedAt: now }, teacher_not_received: { notReceivedAt: now },
      teacher_waive: { waivedAt: now, waivedFrom: dp.status, waivedReason: reason ?? 'teacher_waived' },
    };
    // Compare-and-set: faqat kutilgan eski holatda yangilanadi (poyga holatida ikkinchi so'rov 409 oladi)
    const r = await this.prisma.directPayment.updateMany({ where: { id: dp.id, status: dp.status }, data: { status: next, ...(stamp[event] ?? {}), ...extra } });
    if (r.count === 0) throw new ConflictException({ message: 'Status changed meanwhile; reload', code: 'INVALID_TRANSITION' });
    await this.audit.log(actor, { action: `directpay.${event}`, targetType: 'Booking', targetId: bookingId, metadata: { from: dp.status, to: next } });
    return { b, dp: await this.prisma.directPayment.findUniqueOrThrow({ where: { id: dp.id } }), side };
  }

  async markPaid(actor: Actor, bookingId: string, proofFileId?: string) {
    let extra: Partial<DirectPayment> = {};
    if (proofFileId) {
      const f = await this.prisma.storedFile.findFirst({ where: { id: proofFileId, ownerId: actor.id, deletedAt: null } });
      if (!f) throw new NotFoundException('File not found'); // boshqa birovning faylini ulab bo'lmaydi
      if (f.purpose !== 'PAYMENT_PROOF') throw new BadRequestException('File has wrong purpose');
      if (f.status !== 'READY') throw new ConflictException('File is not ready');
      extra = { proofFileId };
    }
    const { b, dp, side } = await this.transition(actor, bookingId, 'pupil', 'pupil_paid', extra);
    await this.notifications.enqueue(b.teacher.userId, 'directpay.marked', { bookingId }, { dedupeKey: `dp:${dp.id}:marked:${dp.pupilMarkedAt?.getTime()}` });
    return this.view(dp, b, side);
  }

  async confirmReceived(actor: Actor, bookingId: string) {
    const { b, dp, side } = await this.transition(actor, bookingId, 'teacher', 'teacher_received');
    for (const u of await this.pupilRecipients(b)) await this.notifications.enqueue(u, 'directpay.confirmed', { bookingId }, { dedupeKey: `dp:${dp.id}:confirmed:${u}` });
    return this.view(dp, b, side);
  }

  async notReceived(actor: Actor, bookingId: string) {
    const { b, dp, side } = await this.transition(actor, bookingId, 'teacher', 'teacher_not_received');
    for (const u of await this.pupilRecipients(b)) await this.notifications.enqueue(u, 'directpay.not_received', { bookingId }, { dedupeKey: `dp:${dp.id}:notrec:${dp.notReceivedAt?.getTime()}:${u}` });
    return this.view(dp, b, side);
  }

  async waive(actor: Actor, bookingId: string) {
    const { b, dp, side } = await this.transition(actor, bookingId, 'teacher', 'teacher_waive');
    for (const u of await this.pupilRecipients(b)) await this.notifications.enqueue(u, 'directpay.waived', { bookingId }, { dedupeKey: `dp:${dp.id}:waived:${u}` });
    return this.view(dp, b, side);
  }

  /** Test/boshqaruv uchun: holat nomlari */
  static readonly STATUSES: DirectPaymentStatus[] = ['UNPAID', 'PUPIL_MARKED_PAID', 'TEACHER_CONFIRMED', 'NOT_RECEIVED', 'WAIVED'];
}
