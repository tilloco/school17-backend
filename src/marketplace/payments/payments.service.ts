import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException,
} from '@nestjs/common';
import { LessonPayment, PaymentState, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { ClockService } from '../common/clock';
import { marketConfig } from '../common/config';
import { DomainEvents } from '../common/events';
import { NotificationsService } from '../notifications/notifications.service';
import { InsufficientFunds, LedgerService } from './ledger.service';
import { commissionFor, earnedForDuration, looksLikeCardNumber, refundForBps } from './money';
import { PAYMENT_PROVIDER, PaymentProvider } from './payment-provider';

type Tx = Prisma.TransactionClient;

@Injectable()
export class PaymentsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Payments');
  private timer?: NodeJS.Timeout;

  constructor(
    private prisma: PrismaService,
    private ledger: LedgerService,
    private clock: ClockService,
    private audit: AuditService,
    private notifications: NotificationsService,
    private events: DomainEvents,
    @Inject(PAYMENT_PROVIDER) private provider: PaymentProvider,
  ) {}

  onModuleInit() {
    this.events.on('booking.completed', ({ bookingId, billableSeconds }) => this.onCompleted(bookingId, billableSeconds));
    this.events.on('booking.noshow', ({ bookingId, kind }) => (kind === 'NO_SHOW_STUDENT' ? this.settleFull(bookingId) : this.refundAll(bookingId, 'teacher_no_show')));
    this.events.on('booking.failed', ({ bookingId }) => this.flagForReview(bookingId));
    this.events.on('booking.cancelled', ({ bookingId }) => this.onCancelled(bookingId));
    this.events.on('booking.declined', ({ bookingId }) => this.refundAll(bookingId, 'declined'));
    this.events.on('booking.expired', ({ bookingId }) => this.refundAll(bookingId, 'expired'));
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.releaseDue().catch((e) => this.log.error(e.message)), 5 * 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Haqiqiy provayder bo'lmaganda production'da to'lov marshrutlari ISHLAMAYDI (mock bilan pul "qabul qilinmaydi"). */
  private assertConfigured() {
    if (this.provider.name === 'mock' && process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException({ message: 'Payments are not configured', code: 'PAYMENTS_NOT_CONFIGURED' });
    }
  }

  // ---------- to'lash ----------

  async pay(actor: Actor, bookingId: string, idempotencyKey: string, paymentMethod?: string) {
    this.assertConfigured();
    if (!/^[A-Za-z0-9_\-:.]{8,100}$/.test(idempotencyKey)) throw new BadRequestException('Idempotency-Key must be 8-100 chars [A-Za-z0-9_-:.]');
    if (paymentMethod && looksLikeCardNumber(paymentMethod)) throw new BadRequestException('Never send card numbers; use a provider token');
    const b = await this.prisma.booking.findUnique({ where: { id: bookingId }, include: { teacher: { select: { userId: true } } } });
    if (!b || b.bookedById !== actor.id) throw new NotFoundException('Not found');
    const now = this.clock.now();
    if (!['REQUESTED', 'CONFIRMED'].includes(b.status) || b.endAt <= now) throw new ConflictException({ message: 'Booking cannot be paid', code: 'NOT_PAYABLE' });
    const cfg = marketConfig();

    let payment = await this.prisma.lessonPayment.findUnique({ where: { bookingId } });
    if (payment && payment.idempotencyKey === idempotencyKey) return this.finishCharge(payment, paymentMethod, actor);
    if (payment && payment.state !== 'FAILED') {
      throw new ConflictException({ message: payment.state === 'PENDING' ? 'Payment in progress' : 'Already paid', code: payment.state === 'PENDING' ? 'PAYMENT_IN_PROGRESS' : 'ALREADY_PAID' });
    }
    try {
      payment = payment
        ? await this.prisma.lessonPayment.update({ where: { id: payment.id }, data: { idempotencyKey, state: 'PENDING', failureCode: null } })
        : await this.prisma.lessonPayment.create({
            data: { bookingId, payerId: actor.id, teacherUserId: b.teacher.userId, amountMinor: b.priceMinor, currency: b.currency, commissionBps: cfg.commissionBps, provider: this.provider.name, idempotencyKey },
          });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        const again = await this.prisma.lessonPayment.findUnique({ where: { bookingId } });
        if (again?.idempotencyKey === idempotencyKey) return this.finishCharge(again, paymentMethod, actor);
        throw new ConflictException({ message: 'Payment in progress', code: 'PAYMENT_IN_PROGRESS' });
      }
      throw e;
    }
    return this.finishCharge(payment, paymentMethod, actor);
  }

  /** Provayderni chaqiradi (idempotent) va natijani + daftarni yozadi. Qayta chaqirilsa xavfsiz. */
  private async finishCharge(payment: LessonPayment, paymentMethod: string | undefined, actor: Actor) {
    if (payment.state === 'PAID' || payment.state === 'ON_HOLD' || payment.state === 'RELEASED' || payment.state === 'REFUNDED') return this.view(payment);
    const res = await this.provider.charge({
      amountMinor: payment.amountMinor, currency: payment.currency, idempotencyKey: payment.idempotencyKey, payerRef: paymentMethod ?? `user:${payment.payerId}`,
      description: `Lesson ${payment.bookingId}`,
    });
    if (res.status === 'FAILED') {
      const failed = await this.prisma.lessonPayment.update({ where: { id: payment.id }, data: { state: 'FAILED', failureCode: res.failureCode ?? 'declined', providerRef: res.providerRef } });
      throw new HttpException({ message: 'Payment failed', code: 'PAYMENT_FAILED', failureCode: failed.failureCode }, 402);
    }
    const paid = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.lessonPayment.updateMany({ where: { id: payment.id, state: 'PENDING' }, data: { state: 'PAID', providerRef: res.providerRef } });
      if (claimed.count === 1) {
        await this.ledger.post(tx, {
          key: `pay:${payment.id}`, kind: 'PAYMENT_RECEIVED', paymentId: payment.id, bookingId: payment.bookingId,
          lines: [{ account: 'EXTERNAL_PAYMENTS', ownerId: payment.payerId, amount: -payment.amountMinor }, { account: 'ESCROW', amount: payment.amountMinor }],
        });
      }
      return tx.lessonPayment.findUniqueOrThrow({ where: { id: payment.id } });
    });
    await this.audit.log(actor, { action: 'payment.paid', targetType: 'Booking', targetId: payment.bookingId, metadata: { amountMinor: payment.amountMinor } });
    await this.notifications.enqueue(payment.teacherUserId, 'payment.received', { bookingId: payment.bookingId }, { dedupeKey: `payment-received:${payment.id}` });
    return this.view(paid);
  }

  // ---------- yakunlash / qaytarish ----------

  private async loadPaid(bookingId: string) {
    const payment = await this.prisma.lessonPayment.findUnique({ where: { bookingId } });
    return payment && payment.state === 'PAID' ? payment : null;
  }

  /** Dars yakunlandi: davomiylikka qarab hisoblanadi, ortig'i qaytariladi, o'qituvchi ulushi "ushlab turiladi". */
  async onCompleted(bookingId: string, billableSeconds: number) {
    const payment = await this.loadPaid(bookingId);
    if (!payment) return;
    const b = await this.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    const scheduled = Math.floor((b.endAt.getTime() - b.startAt.getTime()) / 1000);
    await this.settle(payment, earnedForDuration(payment.amountMinor, billableSeconds, scheduled), 'lesson_completed');
  }

  private async settleFull(bookingId: string) {
    const payment = await this.loadPaid(bookingId);
    if (payment) await this.settle(payment, payment.amountMinor, 'student_no_show');
  }

  private async refundAll(bookingId: string, why: string) {
    const payment = await this.loadPaid(bookingId);
    if (payment) await this.settle(payment, 0, why);
  }

  private async flagForReview(bookingId: string) {
    const r = await this.prisma.lessonPayment.updateMany({ where: { bookingId, state: 'PAID' }, data: { state: 'UNDER_REVIEW' } });
    if (r.count) await this.audit.log('SYSTEM', { action: 'payment.under_review', targetType: 'Booking', targetId: bookingId });
  }

  private async onCancelled(bookingId: string) {
    const payment = await this.loadPaid(bookingId);
    if (!payment) return;
    const b = await this.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    const bps = b.cancelledByRole === 'TEACHER' ? 10_000 : b.lateCancel ? marketConfig().lateCancelRefundBps : 10_000;
    const refund = refundForBps(payment.amountMinor, bps);
    await this.settle(payment, payment.amountMinor - refund, b.lateCancel && b.cancelledByRole !== 'TEACHER' ? 'late_cancel' : 'cancelled');
  }

  /**
   * ESCROW dagi pulni taqsimlaydi: earned -> o'qituvchi (ushlab turish), qolgani -> to'lovchiga qaytarish.
   * Holat PAID dan faqat bir marta o'tadi (updateMany bilan "egallash"), shuning uchun takror chaqiruv ikki marta to'lamaydi.
   */
  private async settle(payment: LessonPayment, earned: number, why: string) {
    const refund = payment.amountMinor - earned;
    const now = this.clock.now();
    const done = await this.prisma.$transaction(async (tx) => {
      await this.ledger.lockOwner(tx, payment.teacherUserId);
      const claimed = await tx.lessonPayment.updateMany({
        where: { id: payment.id, state: 'PAID' },
        data: { state: earned > 0 ? 'ON_HOLD' : 'REFUNDED', earnedMinor: earned, refundedMinor: refund, releaseAt: earned > 0 ? new Date(now.getTime() + marketConfig().holdHours * 3_600_000) : null },
      });
      if (claimed.count === 0) return false;
      const lines: { account: any; ownerId?: string | null; amount: number }[] = [{ account: 'ESCROW', amount: -payment.amountMinor }];
      if (earned > 0) lines.push({ account: 'TEACHER_PENDING', ownerId: payment.teacherUserId, amount: earned });
      if (refund > 0) lines.push({ account: 'EXTERNAL_PAYMENTS', ownerId: payment.payerId, amount: refund });
      await this.ledger.post(tx, { key: `settle:${payment.id}`, kind: `SETTLE_${why.toUpperCase()}`, paymentId: payment.id, bookingId: payment.bookingId, lines });
      return true;
    });
    if (!done) return;
    if (refund > 0 && payment.providerRef) await this.providerRefund(payment, refund, `settle:${payment.id}`);
    if (earned > 0) await this.notifications.enqueue(payment.teacherUserId, 'payment.on_hold', { bookingId: payment.bookingId }, { dedupeKey: `payment-hold:${payment.id}` });
    if (refund > 0) await this.notifications.enqueue(payment.payerId, 'payment.refunded', { bookingId: payment.bookingId, amountMinor: refund }, { dedupeKey: `payment-refund:${payment.id}:settle` });
    await this.audit.log('SYSTEM', { action: 'payment.settled', targetType: 'Booking', targetId: payment.bookingId, metadata: { why, earned, refund } });
  }

  private async providerRefund(payment: LessonPayment, amount: number, tag: string) {
    try {
      await this.provider.refund({ providerRef: payment.providerRef!, amountMinor: amount, idempotencyKey: `refund:${payment.id}:${tag}` });
    } catch (e: any) {
      // Daftar to'g'ri; provayder bilan tenglashtirish (reconciliation) ishi KNOWN_GAPS da
      this.log.error(`provider refund failed for payment ${payment.id}: ${e.message}`);
    }
  }

  // ---------- ushlab turishdan chiqarish ----------

  async releaseDue(limit = 200): Promise<number> {
    const due = await this.prisma.lessonPayment.findMany({ where: { state: 'ON_HOLD', releaseAt: { lte: this.clock.now() } }, select: { id: true }, take: limit });
    let n = 0;
    for (const d of due) if (await this.releaseOne(d.id)) n++;
    return n;
  }

  private async releaseOne(paymentId: string): Promise<boolean> {
    const p = await this.prisma.lessonPayment.findUnique({ where: { id: paymentId } });
    if (!p || p.state !== 'ON_HOLD') return false;
    const commission = commissionFor(p.earnedMinor, p.commissionBps);
    const net = p.earnedMinor - commission;
    const ok = await this.prisma.$transaction(async (tx) => {
      await this.ledger.lockOwner(tx, p.teacherUserId);
      const claimed = await tx.lessonPayment.updateMany({ where: { id: p.id, state: 'ON_HOLD' }, data: { state: 'RELEASED', commissionMinor: commission } });
      if (claimed.count === 0) return false;
      const lines: { account: any; ownerId?: string | null; amount: number }[] = [{ account: 'TEACHER_PENDING', ownerId: p.teacherUserId, amount: -p.earnedMinor }];
      if (commission > 0) lines.push({ account: 'PLATFORM_REVENUE', amount: commission });
      if (net > 0) lines.push({ account: 'TEACHER_AVAILABLE', ownerId: p.teacherUserId, amount: net });
      await this.ledger.post(tx, { key: `release:${p.id}`, kind: 'RELEASE', paymentId: p.id, bookingId: p.bookingId, lines });
      return true;
    });
    if (ok) await this.notifications.enqueue(p.teacherUserId, 'payment.released', { bookingId: p.bookingId, netMinor: net }, { dedupeKey: `payment-release:${p.id}` });
    return ok;
  }

  // ---------- nizo ----------

  async openDispute(actor: Actor, bookingId: string, reason: string) {
    const p = await this.prisma.lessonPayment.findUnique({ where: { bookingId } });
    if (!p || p.payerId !== actor.id) throw new NotFoundException('Not found');
    const now = this.clock.now();
    if (p.state !== 'ON_HOLD' || !p.releaseAt || p.releaseAt <= now) throw new ConflictException({ message: 'Dispute window closed', code: 'DISPUTE_WINDOW_CLOSED' });
    const text = reason.trim();
    if (text.length < 10) throw new BadRequestException('Please describe the problem (min 10 characters)');
    const r = await this.prisma.lessonPayment.updateMany({ where: { id: p.id, state: 'ON_HOLD' }, data: { state: 'DISPUTED', disputeReason: text.slice(0, 500), disputedAt: now } });
    if (r.count === 0) throw new ConflictException('Dispute window closed');
    await this.audit.log(actor, { action: 'payment.dispute_open', targetType: 'Booking', targetId: bookingId });
    await this.notifications.enqueue(p.teacherUserId, 'payment.disputed', { bookingId }, { dedupeKey: `payment-dispute:${p.id}` });
    return this.view(await this.prisma.lessonPayment.findUniqueOrThrow({ where: { id: p.id } }));
  }

  async reviewQueue() {
    const rows = await this.prisma.lessonPayment.findMany({ where: { state: { in: ['DISPUTED', 'UNDER_REVIEW'] } }, orderBy: { updatedAt: 'asc' }, take: 100 });
    return rows.map((p) => ({ ...this.view(p), disputeReason: p.disputeReason, bookingId: p.bookingId }));
  }

  /** Admin qarori. REFUND(amount?) — qaytarish; RELEASE — o'qituvchiga berish. */
  async adminResolve(admin: Actor, paymentId: string, outcome: 'REFUND' | 'RELEASE', refundMinor: number | undefined, note: string) {
    if (admin.kind !== 'admin') throw new ForbiddenException('Forbidden');
    const p = await this.prisma.lessonPayment.findUnique({ where: { id: paymentId } });
    if (!p) throw new NotFoundException('Not found');
    if (p.state !== 'DISPUTED' && p.state !== 'UNDER_REVIEW') throw new ConflictException(`Cannot resolve from ${p.state}`);
    const fromEscrow = p.state === 'UNDER_REVIEW';
    const pool = fromEscrow ? p.amountMinor : p.earnedMinor; // hozir qaysi hisobdagi pul
    const refund = outcome === 'REFUND' ? (refundMinor ?? pool) : 0;
    if (!Number.isSafeInteger(refund) || refund < 0 || refund > pool) throw new BadRequestException('Invalid refund amount');
    const remaining = pool - refund;
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await this.ledger.lockOwner(tx, p.teacherUserId);
      const claimed = await tx.lessonPayment.updateMany({
        where: { id: p.id, state: p.state },
        data: {
          state: remaining > 0 ? 'ON_HOLD' : 'REFUNDED', earnedMinor: remaining, refundedMinor: fromEscrow ? refund : p.refundedMinor + refund,
          releaseAt: remaining > 0 ? now : null, resolutionNote: note.slice(0, 500),
        },
      });
      if (claimed.count === 0) throw new ConflictException('Already resolved');
      const lines: { account: any; ownerId?: string | null; amount: number }[] = [];
      if (fromEscrow) {
        lines.push({ account: 'ESCROW', amount: -pool });
        if (remaining > 0) lines.push({ account: 'TEACHER_PENDING', ownerId: p.teacherUserId, amount: remaining });
      } else {
        lines.push({ account: 'TEACHER_PENDING', ownerId: p.teacherUserId, amount: -refund });
      }
      if (refund > 0) lines.push({ account: 'EXTERNAL_PAYMENTS', ownerId: p.payerId, amount: refund });
      const real = lines.filter((l) => l.amount !== 0);
      if (real.length >= 2) await this.ledger.post(tx, { key: `resolve:${p.id}`, kind: `RESOLVE_${outcome}`, paymentId: p.id, bookingId: p.bookingId, lines: real });
    });
    if (refund > 0 && p.providerRef) await this.providerRefund(p, refund, `resolve:${p.id}`);
    await this.audit.log(admin, { action: `payment.resolve_${outcome.toLowerCase()}`, targetType: 'Booking', targetId: p.bookingId, metadata: { refund, remaining, note } });
    if (remaining > 0) await this.releaseOne(p.id);
    for (const u of new Set([p.payerId, p.teacherUserId])) await this.notifications.enqueue(u, 'payment.resolved', { bookingId: p.bookingId, outcome });
    return this.view(await this.prisma.lessonPayment.findUniqueOrThrow({ where: { id: p.id } }));
  }

  // ---------- o'qish ----------

  async mine(actor: Actor) {
    const rows = await this.prisma.lessonPayment.findMany({ where: { payerId: actor.id }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map((p) => this.view(p));
  }

  async isPaid(bookingId: string): Promise<boolean> {
    const p = await this.prisma.lessonPayment.findUnique({ where: { bookingId }, select: { state: true } });
    return !!p && ['PAID', 'ON_HOLD', 'DISPUTED', 'RELEASED', 'UNDER_REVIEW'].includes(p.state);
  }

  /** O'qituvchi daromad paneli */
  async earnings(actor: Actor) {
    const id = actor.id;
    const [pending, available, payoutPending, paidOutAgg] = await Promise.all([
      this.ledger.balance('TEACHER_PENDING', id),
      this.ledger.balance('TEACHER_AVAILABLE', id),
      this.ledger.balance('PAYOUT_PENDING', id),
      this.prisma.ledgerEntry.aggregate({ where: { account: 'EXTERNAL_PAYOUTS', ownerId: id }, _sum: { amountMinor: true } }),
    ]);
    const now = this.clock.now();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [recent, month, upcoming] = await Promise.all([
      this.prisma.lessonPayment.findMany({ where: { teacherUserId: id, state: { in: ['ON_HOLD', 'DISPUTED', 'RELEASED', 'REFUNDED'] } }, orderBy: { updatedAt: 'desc' }, take: 20, include: { booking: { select: { startAt: true, durationMin: true } } } }),
      this.prisma.lessonPayment.aggregate({ where: { teacherUserId: id, state: { in: ['ON_HOLD', 'RELEASED'] }, updatedAt: { gte: monthStart } }, _sum: { earnedMinor: true, commissionMinor: true }, _count: { _all: true } }),
      this.prisma.lessonPayment.aggregate({ where: { teacherUserId: id, state: 'PAID' }, _sum: { amountMinor: true }, _count: { _all: true } }),
    ]);
    return {
      currency: 'UZS',
      balances: { pendingMinor: pending, availableMinor: available, payoutPendingMinor: payoutPending, paidOutMinor: Number(paidOutAgg._sum.amountMinor ?? 0n) },
      month: { lessons: month._count._all, grossMinor: month._sum.earnedMinor ?? 0, commissionMinor: month._sum.commissionMinor ?? 0 },
      upcoming: { lessons: upcoming._count._all, expectedGrossMinor: upcoming._sum.amountMinor ?? 0, note: 'Before commission; paid after the lesson completes and the hold ends' },
      commissionBps: marketConfig().commissionBps,
      holdHours: marketConfig().holdHours,
      lessons: recent.map((p) => ({
        bookingId: p.bookingId, startAt: p.booking.startAt, durationMin: p.booking.durationMin, state: p.state, grossMinor: p.earnedMinor,
        commissionMinor: p.state === 'RELEASED' ? p.commissionMinor : commissionFor(p.earnedMinor, p.commissionBps), netMinor: p.earnedMinor - (p.state === 'RELEASED' ? p.commissionMinor : commissionFor(p.earnedMinor, p.commissionBps)),
        releaseAt: p.releaseAt, refundedMinor: p.refundedMinor,
      })),
    };
  }

  // ---------- pul yechish (payout) ----------

  async requestPayout(actor: Actor, amountMinor: number, destination: string, idempotencyKey: string) {
    this.assertConfigured();
    const cfg = marketConfig();
    if (!/^[A-Za-z0-9_\-:.]{8,100}$/.test(idempotencyKey)) throw new BadRequestException('Idempotency-Key must be 8-100 chars');
    const dest = destination.trim();
    if (!dest || dest.length > 40) throw new BadRequestException('Invalid destination');
    if (looksLikeCardNumber(dest)) throw new BadRequestException('Do not enter full card numbers; use a label like "Humo ****1234"');
    if (!Number.isSafeInteger(amountMinor) || amountMinor < cfg.minPayoutMinor) throw new BadRequestException({ message: 'Amount below minimum payout', minPayoutMinor: cfg.minPayoutMinor });

    const existing = await this.prisma.payoutRequest.findUnique({ where: { idempotencyKey } });
    if (existing) {
      if (existing.teacherUserId !== actor.id || Number(existing.amountMinor) !== amountMinor) throw new ConflictException('Idempotency key reused with different parameters');
      return this.payoutView(existing);
    }
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await this.ledger.lockOwner(tx, actor.id);
        if ((await tx.payoutRequest.count({ where: { teacherUserId: actor.id, status: 'REQUESTED' } })) >= 3) throw new ConflictException({ message: 'Too many open payout requests', code: 'TOO_MANY_OPEN' });
        const req = await tx.payoutRequest.create({ data: { teacherUserId: actor.id, amountMinor: BigInt(amountMinor), destination: dest, idempotencyKey } });
        await this.ledger.post(tx, {
          key: `payout-req:${req.id}`, kind: 'PAYOUT_REQUESTED', payoutId: req.id,
          lines: [{ account: 'TEACHER_AVAILABLE', ownerId: actor.id, amount: -amountMinor }, { account: 'PAYOUT_PENDING', ownerId: actor.id, amount: amountMinor }],
        });
        return req;
      });
      await this.audit.log(actor, { action: 'payout.request', targetType: 'PayoutRequest', targetId: created.id, metadata: { amountMinor } });
      return this.payoutView(created);
    } catch (e) {
      if (e instanceof InsufficientFunds) throw new ConflictException({ message: 'Insufficient available balance', code: 'INSUFFICIENT_FUNDS' });
      if ((e as any)?.code === 'P2002') {
        const again = await this.prisma.payoutRequest.findUnique({ where: { idempotencyKey } });
        if (again && again.teacherUserId === actor.id) return this.payoutView(again);
      }
      throw e;
    }
  }

  async myPayouts(actor: Actor) {
    const rows = await this.prisma.payoutRequest.findMany({ where: { teacherUserId: actor.id }, orderBy: { requestedAt: 'desc' }, take: 100 });
    return rows.map((r) => this.payoutView(r));
  }

  async adminPayouts(status: 'REQUESTED' | 'PAID' | 'REJECTED' = 'REQUESTED') {
    const rows = await this.prisma.payoutRequest.findMany({ where: { status }, orderBy: { requestedAt: 'asc' }, take: 100 });
    return rows.map((r) => ({ ...this.payoutView(r), teacherUserId: r.teacherUserId }));
  }

  async adminPay(admin: Actor, payoutId: string) {
    this.assertConfigured();
    const r = await this.prisma.payoutRequest.findUnique({ where: { id: payoutId } });
    if (!r) throw new NotFoundException('Not found');
    if (r.status !== 'REQUESTED') throw new ConflictException(`Payout is ${r.status}`);
    const amount = Number(r.amountMinor);
    const res = await this.provider.payout({ amountMinor: amount, destination: r.destination, idempotencyKey: `payout:${r.id}` });
    if (res.status === 'FAILED') throw new HttpException({ message: 'Provider payout failed; retry or reject', code: 'PAYOUT_FAILED' }, 502);
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.payoutRequest.updateMany({ where: { id: r.id, status: 'REQUESTED' }, data: { status: 'PAID', paidAt: this.clock.now(), providerRef: res.providerRef, reviewedByAdminId: admin.id } });
      if (claimed.count === 0) return;
      await this.ledger.post(tx, {
        key: `payout-paid:${r.id}`, kind: 'PAYOUT_PAID', payoutId: r.id,
        lines: [{ account: 'PAYOUT_PENDING', ownerId: r.teacherUserId, amount: -amount }, { account: 'EXTERNAL_PAYOUTS', ownerId: r.teacherUserId, amount }],
      });
    });
    await this.audit.log(admin, { action: 'payout.paid', targetType: 'PayoutRequest', targetId: r.id, metadata: { amountMinor: amount } });
    await this.notifications.enqueue(r.teacherUserId, 'payout.paid', { payoutId: r.id }, { dedupeKey: `payout-paid:${r.id}` });
    return this.payoutView(await this.prisma.payoutRequest.findUniqueOrThrow({ where: { id: r.id } }));
  }

  async adminReject(admin: Actor, payoutId: string, reason: string) {
    const r = await this.prisma.payoutRequest.findUnique({ where: { id: payoutId } });
    if (!r) throw new NotFoundException('Not found');
    if (!reason.trim()) throw new BadRequestException('Reason required');
    const amount = Number(r.amountMinor);
    await this.prisma.$transaction(async (tx) => {
      await this.ledger.lockOwner(tx, r.teacherUserId);
      const claimed = await tx.payoutRequest.updateMany({ where: { id: r.id, status: 'REQUESTED' }, data: { status: 'REJECTED', rejectReason: reason.slice(0, 300), reviewedByAdminId: admin.id } });
      if (claimed.count === 0) throw new ConflictException(`Payout is ${r.status}`);
      await this.ledger.post(tx, {
        key: `payout-rej:${r.id}`, kind: 'PAYOUT_REJECTED', payoutId: r.id,
        lines: [{ account: 'PAYOUT_PENDING', ownerId: r.teacherUserId, amount: -amount }, { account: 'TEACHER_AVAILABLE', ownerId: r.teacherUserId, amount }],
      });
    });
    await this.audit.log(admin, { action: 'payout.reject', targetType: 'PayoutRequest', targetId: r.id, metadata: { reason } });
    await this.notifications.enqueue(r.teacherUserId, 'payout.rejected', { payoutId: r.id }, { dedupeKey: `payout-rej:${r.id}` });
    return this.payoutView(await this.prisma.payoutRequest.findUniqueOrThrow({ where: { id: r.id } }));
  }

  integrity() {
    return this.ledger.verifyIntegrity();
  }
  trialBalance() {
    return this.ledger.trialBalance();
  }

  // ---------- ko'rinishlar ----------

  private view(p: LessonPayment) {
    return {
      id: p.id, bookingId: p.bookingId, state: p.state, amountMinor: p.amountMinor, currency: p.currency, refundedMinor: p.refundedMinor,
      releaseAt: p.releaseAt, failureCode: p.failureCode, provider: p.provider,
    };
  }

  private payoutView(r: { id: string; amountMinor: bigint; destination: string; status: string; requestedAt: Date; paidAt: Date | null; rejectReason: string | null }) {
    return { id: r.id, amountMinor: Number(r.amountMinor), destination: r.destination, status: r.status, requestedAt: r.requestedAt, paidAt: r.paidAt, rejectReason: r.rejectReason };
  }
}
