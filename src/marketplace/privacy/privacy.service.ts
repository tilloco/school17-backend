import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { ClockService } from '../common/clock';
import { FilesService } from '../files/files.service';
import { LedgerService } from '../payments/ledger.service';

/**
 * Akkauntni o'chirish va ma'lumotlarni eksport qilish.
 * O'chirish = anonimlashtirish: user qatori qoladi (daftar, shikoyatlar va audit jurnali unga bog'langan), lekin shaxsiy ma'lumotlar tozalanadi.
 * Saqlanadigan yozuvlar (muddat NEEDS LAWYER): to'lov daftari, to'lovlar, shikoyatlar, audit jurnali, rozilik isbotlari.
 */
@Injectable()
export class PrivacyService {
  constructor(private prisma: PrismaService, private clock: ClockService, private audit: AuditService, private files: FilesService, private ledger: LedgerService) {}

  /** O'chirishga to'sqinlik qiladigan majburiyatlar (ochiq bronlar, tugallanmagan pul). */
  async blockers(userId: string): Promise<{ code: string; count: number }[]> {
    const now = this.clock.now();
    const out: { code: string; count: number }[] = [];
    const open = await this.prisma.booking.count({
      where: { status: { in: ['REQUESTED', 'CONFIRMED'] }, endAt: { gt: now }, OR: [{ studentId: userId }, { bookedById: userId }, { teacher: { userId } }] },
    });
    if (open) out.push({ code: 'OPEN_BOOKINGS', count: open });
    const money = await this.prisma.lessonPayment.count({
      where: { state: { in: ['PENDING', 'PAID', 'ON_HOLD', 'DISPUTED', 'UNDER_REVIEW'] }, OR: [{ payerId: userId }, { teacherUserId: userId }] },
    });
    if (money) out.push({ code: 'OPEN_PAYMENTS', count: money });
    const [pend, avail, payout, openPayouts] = await Promise.all([
      this.ledger.balance('TEACHER_PENDING', userId), this.ledger.balance('TEACHER_AVAILABLE', userId), this.ledger.balance('PAYOUT_PENDING', userId),
      this.prisma.payoutRequest.count({ where: { teacherUserId: userId, status: 'REQUESTED' } }),
    ]);
    if (pend + avail + payout > 0 || openPayouts) out.push({ code: 'TEACHER_BALANCE', count: pend + avail + payout });
    return out;
  }

  async deleteAccount(actor: Actor) {
    if (actor.kind !== 'user') throw new ForbiddenException('Forbidden');
    const blockers = await this.blockers(actor.id);
    if (blockers.length) throw new ConflictException({ message: 'Resolve open items before deleting your account', code: 'DELETE_BLOCKED', blockers });
    const now = this.clock.now();
    const tp = await this.prisma.teacherProfile.findUnique({ where: { userId: actor.id }, select: { id: true } });
    await this.files.purgeOwnerFiles(actor.id);
    await this.prisma.$transaction(async (tx) => {
      // 1) xabarlar mazmuni va ilovalari
      await tx.chatMessage.updateMany({ where: { senderId: actor.id }, data: { body: '', deletedAt: now, fileId: null } });
      // 2) o'qituvchi profili
      if (tp) {
        await tx.availabilityRule.deleteMany({ where: { teacherId: tp.id } });
        await tx.teacherTimeOff.deleteMany({ where: { teacherId: tp.id } });
        await tx.teacherCredential.deleteMany({ where: { teacherId: tp.id } });
        await tx.review.updateMany({ where: { teacherId: tp.id }, data: { teacherReply: null } });
        await tx.teacherProfile.update({ where: { id: tp.id }, data: { headline: '', bio: '', subjects: [], levels: [], languages: [], introVideoUrl: null, verificationStatus: 'SUSPENDED', rejectionReason: 'account_deleted' } });
      }
      // 3) yozilgan sharhlar: baho qoladi (agregatlar buzilmasin), matn o'chadi
      await tx.review.updateMany({ where: { authorId: actor.id }, data: { text: '' } });
      // 4) bog'lamlar
      await tx.guardianLink.updateMany({ where: { OR: [{ guardianId: actor.id }, { studentId: actor.id }] }, data: { status: 'REVOKED' } });
      await tx.guardianLinkCode.deleteMany({ where: { studentId: actor.id } });
      await tx.userBlock.deleteMany({ where: { OR: [{ blockerId: actor.id }, { blockedId: actor.id }] } });
      await tx.notification.deleteMany({ where: { userId: actor.id } });
      await tx.callEvent.deleteMany({ where: { userId: actor.id } });
      // 5) eski imtihon ilovasi ma'lumotlari (kaskad bilan)
      await tx.userProgress.deleteMany({ where: { userId: actor.id } });
      await tx.userAnswer.deleteMany({ where: { userId: actor.id } });
      await tx.streak.deleteMany({ where: { userId: actor.id } });
      await tx.examSession.deleteMany({ where: { userId: actor.id } });
      await tx.aiRecommendation.deleteMany({ where: { userId: actor.id } });
      await tx.onboardingSession.deleteMany({ where: { userId: actor.id } });
      // 6) foydalanuvchi qatori
      await tx.user.update({
        where: { id: actor.id },
        data: { status: 'DELETED', deletedAt: now, email: `deleted-${actor.id}@deleted.invalid`, name: null, avatarUrl: null, dateOfBirth: null, examDate: null, locale: 'uz' },
      });
    });
    await this.audit.log(actor, { action: 'account.delete', targetType: 'User', targetId: actor.id });
    return { ok: true, retained: ['payment ledger', 'payments', 'safety reports', 'audit log', 'consent records'] };
  }

  /** "Mening ma'lumotlarim": faqat o'zimga tegishli ma'lumotlar. Boshqa foydalanuvchilarning email/id/tug'ilgan sanalari kirmaydi. */
  async exportData(actor: Actor) {
    if (actor.kind !== 'user') throw new ForbiddenException('Forbidden');
    const id = actor.id;
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id } });
    const tp = await this.prisma.teacherProfile.findUnique({ where: { userId: id }, include: { availability: true, timeOff: true, credentials: { select: { kind: true, title: true, status: true, createdAt: true } } } });
    const threads = await this.prisma.chatThread.findMany({ where: { OR: [{ teacherUserId: id }, { studentUserId: id }] }, include: { messages: { where: { deletedAt: null }, orderBy: { seq: 'asc' }, include: { file: { select: { originalName: true, finalMime: true, sizeBytes: true } } } } } });
    const [bookings, payments, payouts, ledger, reviewsWritten, reviewsReceived, files, consents, blocks, reportsMade, notifications, audit, guardians, children, exam] = await Promise.all([
      this.prisma.booking.findMany({ where: { OR: [{ studentId: id }, { bookedById: id }, { teacher: { userId: id } }] }, orderBy: { startAt: 'asc' }, select: { id: true, startAt: true, endAt: true, durationMin: true, status: true, priceMinor: true, currency: true, cancelReason: true, lateCancel: true, actualDurationSec: true, studentId: true, bookedById: true } }),
      this.prisma.lessonPayment.findMany({ where: { OR: [{ payerId: id }, { teacherUserId: id }] }, select: { bookingId: true, state: true, amountMinor: true, currency: true, earnedMinor: true, commissionMinor: true, refundedMinor: true, createdAt: true } }),
      this.prisma.payoutRequest.findMany({ where: { teacherUserId: id }, select: { amountMinor: true, destination: true, status: true, requestedAt: true, paidAt: true } }),
      this.prisma.ledgerEntry.findMany({ where: { ownerId: id }, orderBy: { createdAt: 'asc' }, select: { account: true, amountMinor: true, kind: true, bookingId: true, createdAt: true } }),
      this.prisma.review.findMany({ where: { authorId: id }, select: { bookingId: true, rating: true, text: true, status: true, createdAt: true } }),
      tp ? this.prisma.review.findMany({ where: { teacherId: tp.id }, select: { rating: true, text: true, status: true, teacherReply: true, createdAt: true } }) : Promise.resolve([]),
      this.prisma.storedFile.findMany({ where: { ownerId: id, deletedAt: null }, select: { id: true, purpose: true, originalName: true, finalMime: true, sizeBytes: true, status: true, createdAt: true } }),
      this.prisma.consent.findMany({ where: { userId: id }, select: { kind: true, version: true, acceptedAt: true, withdrawnAt: true } }),
      this.prisma.userBlock.findMany({ where: { blockerId: id }, select: { createdAt: true, blocked: { select: { name: true } } } }),
      this.prisma.report.findMany({ where: { reporterId: id }, select: { targetType: true, reason: true, note: true, status: true, createdAt: true } }),
      this.prisma.notification.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 500, select: { type: true, createdAt: true, readAt: true } }),
      this.prisma.auditLog.findMany({ where: { actorId: id }, orderBy: { createdAt: 'desc' }, take: 1000, select: { action: true, targetType: true, createdAt: true } }),
      this.prisma.guardianLink.findMany({ where: { studentId: id }, select: { status: true, createdAt: true, guardian: { select: { name: true } } } }),
      this.prisma.guardianLink.findMany({ where: { guardianId: id }, select: { status: true, createdAt: true, student: { select: { name: true } } } }),
      this.prisma.userProgress.count({ where: { userId: id } }),
    ]);
    await this.audit.log(actor, { action: 'account.export', targetType: 'User', targetId: id });
    return {
      exportedAt: this.clock.now(),
      note: 'Personal data held about you. Other users\' emails, ids and birth dates are never included.',
      account: { id: u.id, email: u.email, name: u.name, role: u.role, locale: u.locale, timezone: u.timezone, dateOfBirth: u.dateOfBirth ? u.dateOfBirth.toISOString().slice(0, 10) : null, createdAt: u.createdAt },
      teacherProfile: tp && { headline: tp.headline, bio: tp.bio, subjects: tp.subjects, levels: tp.levels, languages: tp.languages, priceMinor: tp.priceMinor, introVideoUrl: tp.introVideoUrl, verificationStatus: tp.verificationStatus, availability: tp.availability.map((a) => ({ weekday: a.weekday, startMinute: a.startMinute, endMinute: a.endMinute })), timeOff: tp.timeOff.map((o) => ({ startAt: o.startAt, endAt: o.endAt, reason: o.reason })), credentials: tp.credentials },
      bookings: bookings.map(({ studentId, bookedById, ...b }) => ({ ...b, myRole: studentId === id ? 'pupil' : bookedById === id ? 'booker' : 'teacher' })),
      conversations: threads.map((t) => ({ with: t.teacherUserId === id ? 'pupil' : 'teacher', messages: t.messages.map((m) => ({ seq: m.seq, mine: m.senderId === id, body: m.body, file: m.file, at: m.createdAt })) })),
      payments, payouts, ledger: ledger.map((l) => ({ ...l, amountMinor: Number(l.amountMinor) })),
      reviewsWritten, reviewsReceived, files, consents,
      blocks: blocks.map((b) => ({ name: b.blocked.name, at: b.createdAt })),
      reportsMade, notifications, activityLog: audit,
      guardians: guardians.map((g) => ({ name: g.guardian.name, status: g.status, since: g.createdAt })),
      children: children.map((c) => ({ name: c.student.name, status: c.status, since: c.createdAt })),
      examAppProgressRecords: exam,
    };
  }
}
