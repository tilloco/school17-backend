import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { GuardianLinkStatus, Role } from '@prisma/client';
import { createHash, randomInt } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor, ADULT_AGE, ageInYears } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { ClockService } from '../common/clock';
import { LegalService } from '../legal/legal.service';
import { NotificationsService } from '../notifications/notifications.service';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0/O, 1/I chalkashtirmaydigan
const CODE_TTL_MS = 24 * 3_600_000;
const MAX_GUARDIANS_PER_CHILD = 5;
const MAX_CHILDREN_PER_GUARDIAN = 10;
const MAX_FAILED_PER_HOUR = 10;

const hash = (code: string) => createHash('sha256').update('guardian-code:' + code.replace(/[^A-Za-z0-9]/g, '').toUpperCase()).digest('hex');

@Injectable()
export class GuardianService {
  constructor(private prisma: PrismaService, private clock: ClockService, private audit: AuditService, private notifications: NotificationsService, private legal: LegalService) {}

  async isActiveGuardianOf(guardianId: string, studentId: string): Promise<boolean> {
    const link = await this.prisma.guardianLink.findUnique({ where: { guardianId_studentId: { guardianId, studentId } } });
    return link?.status === GuardianLinkStatus.ACTIVE;
  }

  async linkedStudentIds(guardianId: string): Promise<string[]> {
    const links = await this.prisma.guardianLink.findMany({ where: { guardianId, status: GuardianLinkStatus.ACTIVE }, select: { studentId: true } });
    return links.map((l) => l.studentId);
  }

  async guardianIdsOf(studentId: string): Promise<string[]> {
    const links = await this.prisma.guardianLink.findMany({ where: { studentId, status: GuardianLinkStatus.ACTIVE }, select: { guardianId: true } });
    return links.map((l) => l.guardianId);
  }

  // ---------- bog'lash oqimi ----------

  /** Voyaga yetmagan o'quvchi bir martalik kod yaratadi (faqat shu paytda ko'rsatiladi; bazada hash). */
  async createCode(actor: Actor) {
    if (actor.role !== Role.STUDENT || !actor.ageKnown || !actor.isMinor) throw new ForbiddenException('Only pupils under 18 can create a guardian code');
    const now = this.clock.now();
    await this.prisma.guardianLinkCode.deleteMany({ where: { studentId: actor.id, usedAt: null } });
    const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    await this.prisma.guardianLinkCode.create({ data: { studentId: actor.id, codeHash: hash(code), expiresAt: new Date(now.getTime() + CODE_TTL_MS) } });
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: new Date(now.getTime() + CODE_TTL_MS) };
  }

  async redeem(actor: Actor, rawCode: string) {
    if (actor.role !== Role.GUARDIAN) throw new ForbiddenException('Forbidden');
    if (!actor.ageKnown || actor.isMinor) throw new ForbiddenException('Guardians must be adults with a known date of birth');
    if (!(await this.legal.hasAccepted(actor.id, 'GUARDIAN_STATEMENT'))) throw new ForbiddenException({ message: 'Accept the guardian statement first', code: 'GUARDIAN_STATEMENT_REQUIRED' });
    const now = this.clock.now();
    const failed = await this.prisma.auditLog.count({ where: { actorId: actor.id, action: 'guardian.redeem_failed', createdAt: { gte: new Date(now.getTime() - 3_600_000) } } });
    if (failed >= MAX_FAILED_PER_HOUR) throw new HttpException({ message: 'Too many attempts, try later', code: 'TOO_MANY_ATTEMPTS' }, 429);
    const normalized = rawCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const row = normalized.length === 8 ? await this.prisma.guardianLinkCode.findUnique({ where: { codeHash: hash(normalized) } }) : null;
    if (!row || row.usedAt || row.expiresAt <= now) {
      await this.audit.log(actor, { action: 'guardian.redeem_failed' });
      throw new NotFoundException({ message: 'Invalid or expired code', code: 'INVALID_CODE' });
    }
    if (row.studentId === actor.id) throw new ForbiddenException('Forbidden');
    const student = await this.prisma.user.findUnique({ where: { id: row.studentId }, select: { id: true, status: true, dateOfBirth: true, name: true } });
    if (!student || student.status !== 'ACTIVE' || !student.dateOfBirth || ageInYears(student.dateOfBirth, now) >= ADULT_AGE) throw new NotFoundException({ message: 'Invalid or expired code', code: 'INVALID_CODE' });
    const [guardiansOfChild, childrenOfGuardian] = await Promise.all([
      this.prisma.guardianLink.count({ where: { studentId: student.id, status: 'ACTIVE' } }),
      this.prisma.guardianLink.count({ where: { guardianId: actor.id, status: 'ACTIVE' } }),
    ]);
    const existing = await this.prisma.guardianLink.findUnique({ where: { guardianId_studentId: { guardianId: actor.id, studentId: student.id } } });
    if (existing?.status !== 'ACTIVE') {
      if (guardiansOfChild >= MAX_GUARDIANS_PER_CHILD) throw new ConflictException({ message: 'Too many guardians linked', code: 'TOO_MANY_GUARDIANS' });
      if (childrenOfGuardian >= MAX_CHILDREN_PER_GUARDIAN) throw new ConflictException({ message: 'Too many children linked', code: 'TOO_MANY_CHILDREN' });
    }
    const used = await this.prisma.guardianLinkCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
    if (used.count === 0) throw new NotFoundException({ message: 'Invalid or expired code', code: 'INVALID_CODE' });
    await this.prisma.guardianLink.upsert({
      where: { guardianId_studentId: { guardianId: actor.id, studentId: student.id } },
      update: { status: 'ACTIVE' },
      create: { guardianId: actor.id, studentId: student.id, status: 'ACTIVE' },
    });
    await this.audit.log(actor, { action: 'guardian.link', targetType: 'User', targetId: student.id });
    await this.notifications.enqueue(student.id, 'guardian.linked', { guardianId: actor.id });
    return { childId: student.id, name: student.name };
  }

  async children(actor: Actor) {
    const links = await this.prisma.guardianLink.findMany({ where: { guardianId: actor.id, status: 'ACTIVE' }, include: { student: { select: { id: true, name: true, dateOfBirth: true } } } });
    const now = this.clock.now();
    return links.map((l) => ({ id: l.student.id, name: l.student.name, age: l.student.dateOfBirth ? ageInYears(l.student.dateOfBirth, now) : null }));
  }

  /** Bola o'z vasiylarini ko'radi (faqat ism; kontakt ma'lumoti yo'q). */
  async guardiansOfMe(actor: Actor) {
    const links = await this.prisma.guardianLink.findMany({ where: { studentId: actor.id, status: 'ACTIVE' }, include: { guardian: { select: { name: true } } } });
    return links.map((l) => ({ name: l.guardian.name, since: l.createdAt }));
  }

  async revoke(actor: Actor, studentId: string) {
    const r = await this.prisma.guardianLink.updateMany({ where: { guardianId: actor.id, studentId, status: 'ACTIVE' }, data: { status: 'REVOKED' } });
    if (r.count === 0) throw new NotFoundException('Not found');
    await this.audit.log(actor, { action: 'guardian.unlink', targetType: 'User', targetId: studentId });
    return { ok: true };
  }

  assertBadInput(cond: boolean, msg: string) {
    if (cond) throw new BadRequestException(msg);
  }
}
