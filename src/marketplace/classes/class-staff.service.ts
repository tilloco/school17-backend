import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Class, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor, ADULT_AGE, ageInYears } from '../common/actor';
import { AuditService } from '../common/audit.service';
import { ClockService } from '../common/clock';
import { displayName } from '../booking/booking-rules';
import { NotificationsService } from '../notifications/notifications.service';

export const MAX_HELPERS = 5;
export type HelperPerm = 'canPayments' | 'canMembers' | 'canChat';

/**
 * A teacher can name a few helpers for a class (the 2-3 people who answer questions and check payment screenshots in a Telegram group).
 * A helper may do ONLY what the teacher switched on: confirm payments, approve join requests, moderate the channel. Nothing else:
 * not edit the class, not see the teacher's money, not remove people.
 */
@Injectable()
export class ClassStaffService {
  constructor(private prisma: PrismaService, private clock: ClockService, private audit: AuditService, private notifications: NotificationsService) {}

  /** What the person may do in this class (the teacher can do everything). */
  async roleIn(actor: Actor, classId: string): Promise<{ teacher: boolean; helper: { canPayments: boolean; canMembers: boolean; canChat: boolean } | null }> {
    const c = await this.prisma.class.findUnique({ where: { id: classId }, select: { teacher: { select: { userId: true } } } });
    if (!c) return { teacher: false, helper: null };
    if (c.teacher.userId === actor.id) return { teacher: true, helper: null };
    const h = await this.prisma.classHelper.findUnique({ where: { classId_userId: { classId, userId: actor.id } } });
    return { teacher: false, helper: h ? { canPayments: h.canPayments, canMembers: h.canMembers, canChat: h.canChat } : null };
  }

  /** The class, if the person is its teacher or a helper holding this permission; otherwise a plain 404 (nobody learns the class exists). */
  async need(actor: Actor, classId: string, perm: HelperPerm): Promise<Class & { teacherUserId: string }> {
    const c = await this.prisma.class.findUnique({ where: { id: classId }, include: { teacher: { select: { userId: true } } } });
    if (!c) throw new NotFoundException('Class not found');
    if (c.teacher.userId !== actor.id) {
      const h = await this.prisma.classHelper.findUnique({ where: { classId_userId: { classId, userId: actor.id } } });
      if (!h || !h[perm]) throw new NotFoundException('Class not found');
    }
    return { ...c, teacherUserId: c.teacher.userId };
  }

  private async ownedBy(actor: Actor, classId: string) {
    if (actor.role !== Role.TEACHER) throw new ForbiddenException('Forbidden');
    const c = await this.prisma.class.findFirst({ where: { id: classId, teacher: { userId: actor.id } } });
    if (!c) throw new NotFoundException('Class not found');
    return c;
  }

  async helpers(actor: Actor, classId: string) {
    await this.ownedBy(actor, classId);
    const rows = await this.prisma.classHelper.findMany({ where: { classId }, orderBy: { createdAt: 'asc' } });
    const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, name: true, username: true, avatarFileId: true } });
    const by = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => ({ userId: r.userId, name: by.get(r.userId)?.name ?? null, username: by.get(r.userId)?.username ?? null, hasPhoto: !!by.get(r.userId)?.avatarFileId, canPayments: r.canPayments, canMembers: r.canMembers, canChat: r.canChat }));
  }

  async addHelper(actor: Actor, classId: string, usernameIn: string, perms: Partial<Record<HelperPerm, boolean>> = {}) {
    const c = await this.ownedBy(actor, classId);
    const username = usernameIn.trim().replace(/^@/, '').toLowerCase();
    if (username.length < 3) throw new BadRequestException('Type the @username');
    const u = await this.prisma.user.findFirst({ where: { username: { equals: username, mode: 'insensitive' }, status: 'ACTIVE' }, select: { id: true, name: true, role: true, dateOfBirth: true } });
    if (!u || u.role === Role.ADMIN) throw new NotFoundException({ message: 'Nobody has this username', code: 'USER_NOT_FOUND' });
    if (u.id === actor.id) throw new BadRequestException('You are the teacher already');
    if (!u.dateOfBirth || ageInYears(u.dateOfBirth, this.clock.now()) < ADULT_AGE) throw new ForbiddenException({ message: 'A helper must be an adult', code: 'HELPER_MUST_BE_ADULT' });
    if ((await this.prisma.classHelper.count({ where: { classId } })) >= MAX_HELPERS) throw new ConflictException({ message: `A class can have up to ${MAX_HELPERS} helpers`, code: 'TOO_MANY_HELPERS' });
    const data = { canPayments: perms.canPayments ?? true, canMembers: perms.canMembers ?? true, canChat: perms.canChat ?? true };
    await this.prisma.classHelper.upsert({ where: { classId_userId: { classId, userId: u.id } }, create: { classId, userId: u.id, ...data }, update: data });
    await this.audit.log(actor, { action: 'class.helper.add', targetType: 'Class', targetId: classId, metadata: { helperId: u.id } });
    await this.notifications.enqueue(u.id, 'class.helper', { classId, title: c.title }).catch(() => undefined);
    return { userId: u.id, name: u.name, ...data };
  }

  async removeHelper(actor: Actor, classId: string, userId: string) {
    await this.ownedBy(actor, classId);
    const r = await this.prisma.classHelper.deleteMany({ where: { classId, userId } });
    if (!r.count) throw new NotFoundException('Helper not found');
    await this.audit.log(actor, { action: 'class.helper.remove', targetType: 'Class', targetId: classId, metadata: { helperId: userId } });
    return { ok: true };
  }

  /** Classes where the person is a helper, with what is waiting for them. */
  async helping(actor: Actor) {
    const rows = await this.prisma.classHelper.findMany({ where: { userId: actor.id }, include: { class: { select: { id: true, title: true, subject: true, status: true, teacher: { select: { user: { select: { name: true } } } } } } }, take: 50 });
    const out = [];
    for (const r of rows) {
      if (r.class.status !== 'ACTIVE') continue;
      const [pending, owed] = await Promise.all([
        r.canMembers ? this.prisma.classEnrollment.count({ where: { classId: r.classId, status: 'PENDING' } }) : Promise.resolve(0),
        r.canPayments ? this.prisma.classPayment.count({ where: { classId: r.classId, status: 'PUPIL_MARKED_PAID' } }) : Promise.resolve(0),
      ]);
      out.push({ classId: r.classId, title: r.class.title, subject: r.class.subject, teacher: r.class.teacher.user.name, canPayments: r.canPayments, canMembers: r.canMembers, canChat: r.canChat, pendingRequests: pending, paymentsToCheck: owed });
    }
    return out;
  }

  /** Display name for a pupil in a staff list: minors show first name and an initial only. */
  nameOf(name: string | null, minor: boolean) { return displayName(name, minor); }
}
