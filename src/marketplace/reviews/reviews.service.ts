import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Review } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { ClockService } from '../common/clock';
import { marketConfig } from '../common/config';
import { displayName } from '../booking/booking-rules';
import { NotificationsService } from '../notifications/notifications.service';
import { bayesianAverage } from './rating';

const clean = (s: string | undefined, max: number) => (s ?? '').replace(/\s+\n/g, '\n').trim().slice(0, max);

@Injectable()
export class ReviewsService {
  constructor(private prisma: PrismaService, private clock: ClockService, private audit: AuditService, private notifications: NotificationsService) {}

  /** Faqat YAKUNLANGAN (COMPLETED) darsga, faqat bronni to'lovchi/yaratuvchi (bronlovchi) tomonidan, bitta dars = bitta sharh. */
  async create(actor: Actor, bookingId: string, input: { rating: number; text?: string }) {
    const cfg = marketConfig();
    const b = await this.prisma.booking.findUnique({ where: { id: bookingId }, include: { teacher: { select: { userId: true } } } });
    // Begona uchun mavjudlik oshkor qilinmaydi
    if (!b || b.bookedById !== actor.id) throw new NotFoundException('Not found');
    if (b.teacher.userId === actor.id) throw new ForbiddenException('Forbidden');
    if (b.status !== 'COMPLETED' || !b.completedAt) throw new ConflictException({ message: 'Only completed lessons can be reviewed', code: 'NOT_COMPLETED' });
    const now = this.clock.now();
    if (now.getTime() - b.completedAt.getTime() > cfg.reviewWindowDays * 86_400_000) throw new ConflictException({ message: 'Review window closed', code: 'WINDOW_CLOSED' });
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) throw new BadRequestException('Rating must be 1..5');
    let review: Review;
    try {
      review = await this.prisma.review.create({ data: { bookingId, teacherId: b.teacherId, authorId: actor.id, rating: input.rating, text: clean(input.text, 1000), createdAt: now } });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException({ message: 'Already reviewed', code: 'ALREADY_REVIEWED' });
      throw e;
    }
    await this.recompute(b.teacherId);
    await this.audit.log(actor, { action: 'review.create', targetType: 'Review', targetId: review.id, metadata: { rating: input.rating } });
    await this.notifications.enqueue(b.teacher.userId, 'review.new', { reviewId: review.id });
    return this.ownView(review);
  }

  /**
   * Sinf sharhi: faqat shu sinfga yozilgan (yozgan) kishi, sinfda kamida 2 ta TUGAGAN darsda qatnashgan bo'lsa. Har sinfga bittadan.
   * Shunday qilib baho "haqiqiy": o'qituvchi yoki do'sti soxta baho qo'sha olmaydi.
   */
  async createForClass(actor: Actor, classId: string, input: { rating: number; text?: string }) {
    const e = await this.prisma.classEnrollment.findFirst({ where: { classId, enrolledById: actor.id }, include: { class: { include: { teacher: { select: { id: true, userId: true } } } } } });
    if (!e || e.class.teacher.userId === actor.id) throw new NotFoundException('Not found');
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) throw new BadRequestException('Rating must be 1..5');
    const attended = await this.prisma.classAttendance.count({ where: { pupilId: e.pupilId, session: { classId, status: 'ENDED', teacherNoShow: false } } });
    if (attended < 2) throw new ConflictException({ message: 'Attend at least 2 lessons of this class first', code: 'NOT_ENOUGH_LESSONS', attended });
    const now = this.clock.now();
    let review: Review;
    try {
      review = await this.prisma.review.create({ data: { classId, teacherId: e.class.teacher.id, authorId: actor.id, rating: input.rating, text: clean(input.text, 1000), createdAt: now } });
    } catch (err: any) {
      if (err?.code === 'P2002') throw new ConflictException({ message: 'Already reviewed', code: 'ALREADY_REVIEWED' });
      throw err;
    }
    await this.recompute(e.class.teacher.id);
    await this.audit.log(actor, { action: 'review.create', targetType: 'Review', targetId: review.id, metadata: { rating: input.rating, classId } });
    await this.notifications.enqueue(e.class.teacher.userId, 'review.new', { reviewId: review.id });
    return this.ownView(review);
  }

  /** Sinf sharhi mumkinmi: kamida 2 ta tugagan dars va hali sharh yo'q. */
  async classReviewState(actor: Actor, classId: string) {
    const e = await this.prisma.classEnrollment.findFirst({ where: { classId, enrolledById: actor.id } });
    if (!e) throw new NotFoundException('Not found');
    const [attended, mine] = await Promise.all([
      this.prisma.classAttendance.count({ where: { pupilId: e.pupilId, session: { classId, status: 'ENDED', teacherNoShow: false } } }),
      this.prisma.review.findFirst({ where: { classId, authorId: actor.id } }),
    ]);
    return { attended, canReview: attended >= 2 && !mine, review: mine ? this.ownView(mine) : null };
  }

  async update(actor: Actor, reviewId: string, input: { rating?: number; text?: string }) {
    const r = await this.prisma.review.findFirst({ where: { id: reviewId, authorId: actor.id } });
    if (!r) throw new NotFoundException('Not found');
    if (r.status === 'HIDDEN' || r.textHidden) throw new ConflictException('Review is hidden');
    if (this.clock.now().getTime() - r.createdAt.getTime() > marketConfig().reviewEditHours * 3_600_000) throw new ConflictException({ message: 'Edit window closed', code: 'EDIT_WINDOW_CLOSED' });
    if (input.rating !== undefined && (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5)) throw new BadRequestException('Rating must be 1..5');
    const updated = await this.prisma.review.update({
      where: { id: r.id },
      data: { ...(input.rating !== undefined ? { rating: input.rating } : {}), ...(input.text !== undefined ? { text: clean(input.text, 1000) } : {}), editedAt: this.clock.now() },
    });
    await this.recompute(r.teacherId);
    return this.ownView(updated);
  }

  /** Faqat sharh berilgan o'qituvchining o'zi, bir marta javob beradi (tahrir: 48 soat). */
  async reply(actor: Actor, reviewId: string, text: string) {
    const r = await this.prisma.review.findUnique({ where: { id: reviewId }, include: { teacher: { select: { userId: true } } } });
    if (!r || r.teacher.userId !== actor.id) throw new NotFoundException('Not found');
    if (r.status !== 'VISIBLE' || r.textHidden) throw new ConflictException('Review is hidden');
    const body = clean(text, 1000);
    if (!body) throw new BadRequestException('Empty reply');
    if (r.repliedAt && this.clock.now().getTime() - r.repliedAt.getTime() > marketConfig().reviewEditHours * 3_600_000) throw new ConflictException({ message: 'Reply is locked', code: 'REPLY_LOCKED' });
    const updated = await this.prisma.review.update({ where: { id: r.id }, data: { teacherReply: body, repliedAt: r.repliedAt ?? this.clock.now() } });
    await this.notifications.enqueue(r.authorId, 'review.reply', { reviewId: r.id }, { dedupeKey: `review-reply:${r.id}` });
    return this.ownView(updated);
  }

  async listForTeacher(profileId: string, page = 1, pageSize = 20) {
    const p = await this.prisma.teacherProfile.findFirst({ where: { id: profileId, verificationStatus: 'VERIFIED', user: { status: 'ACTIVE' } }, select: { id: true, ratingCount: true, ratingSum: true, ratingBayes: true } });
    if (!p) throw new NotFoundException('Not found');
    const take = Math.min(Math.max(1, pageSize), 50);
    const rows = await this.prisma.review.findMany({
      where: { teacherId: profileId, status: 'VISIBLE' }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (Math.max(1, page) - 1) * take, take,
      include: { author: { select: { name: true } } },
    });
    const dist = await this.prisma.review.groupBy({ by: ['rating'], where: { teacherId: profileId, status: 'VISIBLE' }, _count: { _all: true } });
    return {
      summary: { count: p.ratingCount, average: p.ratingCount ? Math.round((p.ratingSum / p.ratingCount) * 100) / 100 : null, bayesian: Math.round(p.ratingBayes * 100) / 100, distribution: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, dist.find((d) => d.rating === n)?._count._all ?? 0])) },
      items: rows.map((r) => ({
        id: r.id, rating: r.rating, text: r.textHidden ? '' : r.text, textHidden: r.textHidden, createdAt: r.createdAt, edited: !!r.editedAt,
        author: displayName(r.author.name, true), // faqat "Ism F."
        reply: r.teacherReply && !r.textHidden ? { text: r.teacherReply, at: r.repliedAt } : null,
      })),
    };
  }

  async mine(actor: Actor) {
    const rows = await this.prisma.review.findMany({ where: { authorId: actor.id }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map((r) => this.ownView(r));
  }

  /** Hali sharh qoldirilmagan, yakunlangan va oyna ichidagi darslar */
  async pending(actor: Actor) {
    const since = new Date(this.clock.now().getTime() - marketConfig().reviewWindowDays * 86_400_000);
    const rows = await this.prisma.booking.findMany({
      where: { bookedById: actor.id, status: 'COMPLETED', completedAt: { gte: since }, review: null },
      orderBy: { completedAt: 'desc' }, take: 50, include: { teacher: { select: { id: true, user: { select: { name: true } } } } },
    });
    return rows.map((b) => ({ bookingId: b.id, teacher: { id: b.teacher.id, name: b.teacher.user.name }, completedAt: b.completedAt }));
  }

  // ---------- moderatsiya ----------

  async setHidden(admin: Actor, reviewId: string, hidden: boolean, reason?: string) {
    if (admin.kind !== 'admin') throw new ForbiddenException('Forbidden');
    const r = await this.prisma.review.findUnique({ where: { id: reviewId } });
    if (!r) throw new NotFoundException('Not found');
    // Yulduz baho HECH QACHON yashirilmaydi (admin ham, o'qituvchi ham yashira olmaydi): faqat MATN yashiriladi, baho hisobda qoladi.
    await this.prisma.review.update({ where: { id: r.id }, data: { textHidden: hidden, hiddenReason: hidden ? (reason ?? '').slice(0, 300) : null } });
    await this.recompute(r.teacherId);
    await this.audit.log(admin, { action: hidden ? 'review.hide' : 'review.restore', targetType: 'Review', targetId: r.id, metadata: { reason } });
  }

  /** Agregatlarni FAQAT ko'rinadigan sharhlardan qayta hisoblaydi (idempotent: istalgan paytda xavfsiz chaqiriladi). */
  async recompute(teacherId: string) {
    const agg = await this.prisma.review.aggregate({ where: { teacherId, status: 'VISIBLE' }, _count: { _all: true }, _sum: { rating: true } });
    const count = agg._count._all;
    const sum = agg._sum.rating ?? 0;
    await this.prisma.teacherProfile.update({ where: { id: teacherId }, data: { ratingCount: count, ratingSum: sum, ratingBayes: bayesianAverage(sum, count) } });
  }

  private ownView(r: Review) {
    return {
      id: r.id, bookingId: r.bookingId, teacherId: r.teacherId, rating: r.rating, text: r.text, status: r.status, createdAt: r.createdAt, editedAt: r.editedAt,
      reply: r.teacherReply ? { text: r.teacherReply, at: r.repliedAt } : null,
      canEditUntil: new Date(r.createdAt.getTime() + marketConfig().reviewEditHours * 3_600_000),
    };
  }
}
