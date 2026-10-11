import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ReportReason, ReportStatus, ReportTargetType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { ClockService } from '../common/clock';
import { GuardianService } from '../guardian/guardian.service';
import { ReviewsService } from '../reviews/reviews.service';

export type ResolveAction = 'ACTION' | 'DISMISS';

/**
 * Umumiy shikoyat navbati. Hozircha REVIEW qo'llab-quvvatlanadi; USER va MESSAGE S9 da qo'shiladi
 * (har bir nishon turi uchun: mavjudlik/ruxsat tekshiruvi, snapshot va "choralar ko'rish" amali).
 */
@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService, private audit: AuditService, private clock: ClockService, private reviews: ReviewsService, private guardians: GuardianService) {}

  async create(actor: Actor, input: { targetType: ReportTargetType; targetId: string; reason: ReportReason; note?: string }) {
    await this.assertReportable(actor, input.targetType, input.targetId);
    try {
      const r = await this.prisma.report.create({
        data: { reporterId: actor.id, targetType: input.targetType, targetId: input.targetId, reason: input.reason, note: (input.note ?? '').trim().slice(0, 1000) },
      });
      await this.audit.log(actor, { action: 'report.create', targetType: input.targetType, targetId: input.targetId, metadata: { reason: input.reason } });
      return { id: r.id, status: r.status };
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException({ message: 'You already reported this', code: 'ALREADY_REPORTED' });
      throw e;
    }
  }

  /** Suhbat ichidan shikoyat: boshqa tomon (USER) yoki bitta xabar (MESSAGE). Faqat suhbat ishtirokchisi yoki o'quvchining vasiysi. */
  async createFromThread(actor: Actor, threadId: string, input: { messageId?: string; reason: ReportReason; note?: string }) {
    const t = await this.prisma.chatThread.findUnique({ where: { id: threadId } });
    if (!t) throw new NotFoundException('Not found');
    let target: string | null = null;
    if (t.teacherUserId === actor.id) target = t.studentUserId;
    else if (t.studentUserId === actor.id) target = t.teacherUserId;
    else if (await this.guardians.isActiveGuardianOf(actor.id, t.studentUserId)) target = t.teacherUserId;
    if (!target) throw new NotFoundException('Not found');
    const tail = async (beforeSeq?: number, n = 6) =>
      (await this.prisma.chatMessage.findMany({ where: { threadId, deletedAt: null, ...(beforeSeq ? { seq: { lte: beforeSeq } } : {}) }, orderBy: { seq: 'desc' }, take: n })).reverse()
        .map((m) => ({ seq: m.seq, from: m.senderId === t.teacherUserId ? 'TEACHER' : 'STUDENT', body: m.body, hasFile: !!m.fileId, at: m.createdAt }));
    let targetType: ReportTargetType = 'USER';
    let targetId = target;
    let context;
    if (input.messageId) {
      const m = await this.prisma.chatMessage.findFirst({ where: { id: input.messageId, threadId, deletedAt: null } });
      if (!m) throw new NotFoundException('Not found');
      if (m.senderId === actor.id) throw new ForbiddenException('You cannot report your own message');
      targetType = 'MESSAGE';
      targetId = m.id;
      context = await tail(m.seq, 6);
    } else {
      context = await tail(undefined, 10);
    }
    try {
      const r = await this.prisma.report.create({
        data: { reporterId: actor.id, targetType, targetId, reason: input.reason, note: (input.note ?? '').trim().slice(0, 1000), snapshot: { threadId, reportedUserId: target, context } as any },
      });
      await this.audit.log(actor, { action: 'report.create', targetType, targetId, metadata: { reason: input.reason, threadId } });
      return { id: r.id, status: r.status };
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException({ message: 'You already reported this', code: 'ALREADY_REPORTED' });
      throw e;
    }
  }

  private async assertReportable(actor: Actor, type: ReportTargetType, id: string) {
    if (type === 'REVIEW') {
      const r = await this.prisma.review.findFirst({ where: { id, status: 'VISIBLE' }, include: { teacher: { select: { verificationStatus: true } } } });
      if (!r || r.teacher.verificationStatus !== 'VERIFIED') throw new NotFoundException('Not found');
      if (r.authorId === actor.id) throw new ForbiddenException('You cannot report your own review');
      return;
    }
    throw new BadRequestException('Unsupported target type');
  }

  async queue(status: ReportStatus = 'OPEN', targetType?: ReportTargetType, skip = 0, take = 30) {
    const rows = await this.prisma.report.findMany({
      where: { status, ...(targetType ? { targetType } : {}) }, orderBy: { createdAt: 'asc' }, skip, take: Math.min(take, 100),
    });
    return Promise.all(rows.map(async (r) => ({
      id: r.id, targetType: r.targetType, targetId: r.targetId, reason: r.reason, note: r.note, status: r.status, createdAt: r.createdAt, reporterId: r.reporterId,
      target: await this.snapshot(r.targetType, r.targetId, r.snapshot),
    })));
  }

  private async snapshot(type: ReportTargetType, id: string, stored?: unknown) {
    if (stored) return stored;
    if (type === 'REVIEW') {
      const r = await this.prisma.review.findUnique({ where: { id } });
      return r ? { rating: r.rating, text: r.text, status: r.status, reply: r.teacherReply, teacherId: r.teacherId } : null;
    }
    return null;
  }

  /** Akkauntni to'xtatish: foydalanuvchi keyingi so'rovdayoq 401 oladi; o'qituvchi profili ham yashiriladi. */
  async setUserSuspended(admin: Actor, userId: string, suspended: boolean, reason: string) {
    if (admin.kind !== 'admin') throw new ForbiddenException('Forbidden');
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u || u.status === 'DELETED') throw new NotFoundException('Not found');
    await this.prisma.user.update({ where: { id: userId }, data: { status: suspended ? 'SUSPENDED' : 'ACTIVE' } });
    const tp = await this.prisma.teacherProfile.findUnique({ where: { userId } });
    if (tp && suspended && tp.verificationStatus === 'VERIFIED') await this.prisma.teacherProfile.update({ where: { id: tp.id }, data: { verificationStatus: 'SUSPENDED', rejectionReason: reason.slice(0, 500) } });
    await this.audit.log(admin, { action: suspended ? 'user.suspend' : 'user.reinstate', targetType: 'User', targetId: userId, metadata: { reason } });
    return { id: userId, status: suspended ? 'SUSPENDED' : 'ACTIVE' };
  }

  async resolve(admin: Actor, reportId: string, action: ResolveAction, note?: string) {
    if (admin.kind !== 'admin') throw new ForbiddenException('Forbidden');
    const r = await this.prisma.report.findUnique({ where: { id: reportId } });
    if (!r) throw new NotFoundException('Not found');
    if (r.status !== 'OPEN') throw new ConflictException('Report already resolved');
    if (action === 'ACTION') {
      if (r.targetType === 'REVIEW') await this.reviews.setHidden(admin, r.targetId, true, note ?? `report:${r.reason}`);
      else if (r.targetType === 'MESSAGE') {
        await this.prisma.chatMessage.updateMany({ where: { id: r.targetId }, data: { deletedAt: this.clock.now() } });
        await this.prisma.classMessage.updateMany({ where: { id: r.targetId, deletedAt: null }, data: { deletedAt: this.clock.now() } }); // sinf chati (R3)
      } else if (r.targetType === 'CLASS_FILE') {
        await this.prisma.classFile.updateMany({ where: { id: r.targetId }, data: { takedownAt: this.clock.now() } });
        await this.prisma.classSession.updateMany({ where: { presentFileId: r.targetId }, data: { presentFileId: null, presentPage: 1 } });
      }
      else if (r.targetType === 'USER') await this.setUserSuspended(admin, r.targetId, true, note ?? `report:${r.reason}`);
    }
    const updated = await this.prisma.report.update({
      where: { id: r.id },
      data: { status: action === 'ACTION' ? 'ACTIONED' : 'DISMISSED', resolutionNote: (note ?? '').slice(0, 500), resolvedByAdminId: admin.id, resolvedAt: this.clock.now() },
    });
    await this.audit.log(admin, { action: `report.${action.toLowerCase()}`, targetType: 'Report', targetId: r.id, metadata: { target: `${r.targetType}:${r.targetId}` } });
    return { id: updated.id, status: updated.status };
  }
}
