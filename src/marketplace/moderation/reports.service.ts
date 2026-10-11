import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ReportReason, ReportStatus, ReportTargetType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { ClockService } from '../common/clock';
import { ReviewsService } from '../reviews/reviews.service';

export type ResolveAction = 'ACTION' | 'DISMISS';

/**
 * Umumiy shikoyat navbati. Hozircha REVIEW qo'llab-quvvatlanadi; USER va MESSAGE S9 da qo'shiladi
 * (har bir nishon turi uchun: mavjudlik/ruxsat tekshiruvi, snapshot va "choralar ko'rish" amali).
 */
@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService, private audit: AuditService, private clock: ClockService, private reviews: ReviewsService) {}

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
      target: await this.snapshot(r.targetType, r.targetId),
    })));
  }

  private async snapshot(type: ReportTargetType, id: string) {
    if (type === 'REVIEW') {
      const r = await this.prisma.review.findUnique({ where: { id } });
      return r ? { rating: r.rating, text: r.text, status: r.status, reply: r.teacherReply, teacherId: r.teacherId } : null;
    }
    return null;
  }

  async resolve(admin: Actor, reportId: string, action: ResolveAction, note?: string) {
    if (admin.kind !== 'admin') throw new ForbiddenException('Forbidden');
    const r = await this.prisma.report.findUnique({ where: { id: reportId } });
    if (!r) throw new NotFoundException('Not found');
    if (r.status !== 'OPEN') throw new ConflictException('Report already resolved');
    if (action === 'ACTION' && r.targetType === 'REVIEW') await this.reviews.setHidden(admin, r.targetId, true, note ?? `report:${r.reason}`);
    const updated = await this.prisma.report.update({
      where: { id: r.id },
      data: { status: action === 'ACTION' ? 'ACTIONED' : 'DISMISSED', resolutionNote: (note ?? '').slice(0, 500), resolvedByAdminId: admin.id, resolvedAt: this.clock.now() },
    });
    await this.audit.log(admin, { action: `report.${action.toLowerCase()}`, targetType: 'Report', targetId: r.id, metadata: { target: `${r.targetType}:${r.targetId}` } });
    return { id: updated.id, status: updated.status };
  }
}
