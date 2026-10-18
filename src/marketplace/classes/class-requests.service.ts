import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Class } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor, ADULT_AGE, ageInYears } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { ClockService } from '../common/clock';
import { displayName } from '../booking/booking-rules';
import { GuardianService } from '../guardian/guardian.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ClassRemindersService } from './class-reminders.service';
import { ClassStaffService } from './class-staff.service';

/**
 * Closed classes: instead of a code that lets anyone in, the teacher can ask people to REQUEST a place (optionally with a photo of
 * their payment). The teacher or a helper looks at the photo and approves or declines. This is the "send a screenshot, get added to the
 * private group" step of a Telegram group, done inside the class.
 */
@Injectable()
export class ClassRequestsService {
  constructor(
    private prisma: PrismaService,
    private clock: ClockService,
    private audit: AuditService,
    private notifications: NotificationsService,
    private guardians: GuardianService,
    private reminders: ClassRemindersService,
    private staff: ClassStaffService,
  ) {}

  private async notifyPupil(pupilId: string, send: (userId: string) => Promise<unknown>) {
    for (const uid of [pupilId, ...(await this.guardians.guardianIdsOf(pupilId))]) await send(uid).catch(() => undefined);
  }

  /** A pupil (or their guardian) asks for a place. Returns the "waiting" answer the app shows. */
  async create(actor: Actor, c: Class, pupilId: string, input: { proofFileId?: string; note?: string }) {
    const note = (input.note ?? '').replace(/\s+\n/g, '\n').trim().slice(0, 300);
    if (c.requireProof && !input.proofFileId) throw new BadRequestException({ message: 'Attach the photo of your payment', code: 'PROOF_REQUIRED' });
    if (input.proofFileId) {
      const f = await this.prisma.storedFile.findFirst({ where: { id: input.proofFileId, ownerId: actor.id, purpose: 'PAYMENT_PROOF', status: 'READY', deletedAt: null }, select: { id: true } });
      if (!f) throw new NotFoundException('File not found');
    }
    const existing = await this.prisma.classEnrollment.findUnique({ where: { classId_pupilId: { classId: c.id, pupilId } } });
    if (existing?.status === 'PENDING') throw new ConflictException({ message: 'Your request is waiting for approval', code: 'ALREADY_REQUESTED' });
    const data = { status: 'PENDING' as const, enrolledById: actor.id, proofFileId: input.proofFileId ?? null, note: note || null, decidedAt: null, decidedById: null, endedAt: null };
    if (existing) await this.prisma.classEnrollment.update({ where: { id: existing.id }, data });
    else await this.prisma.classEnrollment.create({ data: { classId: c.id, pupilId, ...data } });
    await this.audit.log(actor, { action: 'class.join.request', targetType: 'Class', targetId: c.id, metadata: { pupilId } });
    const teacher = await this.prisma.teacherProfile.findUnique({ where: { id: c.teacherId }, select: { userId: true } });
    const helpers = await this.prisma.classHelper.findMany({ where: { classId: c.id, canMembers: true }, select: { userId: true } });
    for (const uid of new Set([teacher?.userId, ...helpers.map((h) => h.userId)].filter(Boolean) as string[])) {
      await this.notifications.enqueue(uid, 'class.request', { classId: c.id, title: c.title }, { dedupeKey: `class-request:${c.id}:${pupilId}:${Math.floor(this.clock.now().getTime() / 3_600_000)}` }).catch(() => undefined);
    }
    return { pending: true as const, classId: c.id, title: c.title };
  }

  async list(actor: Actor, classId: string) {
    await this.staff.need(actor, classId, 'canMembers');
    const now = this.clock.now();
    const rows = await this.prisma.classEnrollment.findMany({ where: { classId, status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 200, include: { pupil: { select: { name: true, dateOfBirth: true } } } });
    return rows.map((r) => {
      const minor = !r.pupil.dateOfBirth || ageInYears(r.pupil.dateOfBirth, now) < ADULT_AGE;
      return { id: r.id, name: displayName(r.pupil.name, minor), minor, note: r.note, hasProof: !!r.proofFileId, byGuardian: r.enrolledById !== r.pupilId, at: r.createdAt };
    });
  }

  async decide(actor: Actor, classId: string, enrollmentId: string, approve: boolean) {
    const c = await this.staff.need(actor, classId, 'canMembers');
    const e = await this.prisma.classEnrollment.findFirst({ where: { id: enrollmentId, classId, status: 'PENDING' } });
    if (!e) throw new NotFoundException('Request not found');
    const now = this.clock.now();
    if (approve) {
      // the seat count is checked and taken in one step, like a normal join
      await this.prisma.$transaction(async (tx) => {
        const n = await tx.$executeRaw`UPDATE "Class" SET "enrolledCount" = "enrolledCount" + 1 WHERE id = ${classId} AND "status" = 'ACTIVE' AND "enrolledCount" < "capacity"`;
        if (n === 0) throw new ConflictException({ message: 'The class is full', code: 'CLASS_FULL' });
        const r = await tx.classEnrollment.updateMany({ where: { id: e.id, status: 'PENDING' }, data: { status: 'ACTIVE', decidedAt: now, decidedById: actor.id, endedAt: null } });
        if (r.count === 0) throw new ConflictException({ message: 'Already decided', code: 'ALREADY_DECIDED' });
      });
      await this.reminders.sync(classId);
    } else {
      const r = await this.prisma.classEnrollment.updateMany({ where: { id: e.id, status: 'PENDING' }, data: { status: 'DECLINED', decidedAt: now, decidedById: actor.id } });
      if (r.count === 0) throw new ConflictException({ message: 'Already decided', code: 'ALREADY_DECIDED' });
    }
    await this.audit.log(actor, { action: approve ? 'class.join.approve' : 'class.join.decline', targetType: 'Class', targetId: classId, metadata: { pupilId: e.pupilId } });
    if (approve) await this.notifyPupil(e.pupilId, (uid) => this.notifications.enqueue(uid, 'class.approved', { classId, title: c.title }));
    else await this.notifyPupil(e.pupilId, (uid) => this.notifications.enqueue(uid, 'class.declined', { classId, title: c.title }));
    return { ok: true, approved: approve };
  }

  /** The payment photo of a request: only the teacher and helpers who check members or payments may see it. */
  async proofFile(actor: Actor, classId: string, enrollmentId: string) {
    const c = await this.prisma.class.findUnique({ where: { id: classId }, select: { id: true } });
    if (!c) throw new NotFoundException('Not found');
    let allowed = false;
    for (const perm of ['canMembers', 'canPayments'] as const) {
      try { await this.staff.need(actor, classId, perm); allowed = true; break; } catch { /* try the next permission */ }
    }
    if (!allowed) throw new NotFoundException('Not found');
    const e = await this.prisma.classEnrollment.findFirst({ where: { id: enrollmentId, classId, proofFileId: { not: null } }, select: { proofFileId: true } });
    if (!e?.proofFileId) throw new NotFoundException('Not found');
    const f = await this.prisma.storedFile.findFirst({ where: { id: e.proofFileId, deletedAt: null, status: 'READY' } });
    if (!f?.thumbKey) throw new NotFoundException('Not found');
    return f;
  }

  /** A pupil who has asked and is waiting (or was declined) sees that in the app. */
  async myRequests(actor: Actor) {
    const rows = await this.prisma.classEnrollment.findMany({ where: { pupilId: actor.id, status: { in: ['PENDING', 'DECLINED'] } }, orderBy: { createdAt: 'desc' }, take: 20, include: { class: { select: { id: true, title: true } } } });
    return rows.map((r) => ({ classId: r.classId, title: r.class.title, status: r.status, at: r.createdAt }));
  }
}
