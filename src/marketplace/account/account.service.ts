import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor, ADULT_AGE, ageInYears, MIN_ACCOUNT_AGE } from '../common/actor';
import { AuditService } from '../common/audit.service';

export const LOCALES = ['uz', 'ru', 'en'] as const;

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface UpdateMeInput {
  name?: string;
  locale?: string;
  timezone?: string;
  dateOfBirth?: string;
}

@Injectable()
export class AccountService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async me(actor: Actor) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      locale: u.locale,
      timezone: u.timezone,
      dateOfBirth: u.dateOfBirth ? u.dateOfBirth.toISOString().slice(0, 10) : null,
      isMinor: actor.isMinor,
      ageKnown: actor.ageKnown,
    };
  }

  async update(actor: Actor, input: UpdateMeInput) {
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name.trim().slice(0, 100);
    if (input.locale !== undefined) {
      if (!(LOCALES as readonly string[]).includes(input.locale)) throw new BadRequestException('Unsupported locale');
      data.locale = input.locale;
    }
    if (input.timezone !== undefined) {
      if (!isValidTimezone(input.timezone)) throw new BadRequestException('Invalid timezone');
      data.timezone = input.timezone;
    }
    if (input.dateOfBirth !== undefined) {
      const current = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { dateOfBirth: true } });
      // Tug'ilgan sana bir marta kiritiladi: keyin o'zgartirish yosh cheklovlarini aylanib o'tish yo'li bo'lardi.
      if (current.dateOfBirth) throw new ForbiddenException('Date of birth is already set; contact support');
      const dob = new Date(`${input.dateOfBirth}T00:00:00.000Z`);
      const now = new Date();
      if (Number.isNaN(dob.getTime()) || dob > now) throw new BadRequestException('Invalid date of birth');
      if (ageInYears(dob, now) < MIN_ACCOUNT_AGE) throw new ForbiddenException('Under minimum age');
      data.dateOfBirth = dob;
      await this.audit.log(actor, { action: 'account.dob_set', targetType: 'User', targetId: actor.id });
    }
    await this.prisma.user.update({ where: { id: actor.id }, data });
    return this.me({ ...actor, ...(await this.refreshAge(actor.id)) });
  }

  private async refreshAge(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return {
      ageKnown: !!u.dateOfBirth,
      isMinor: u.dateOfBirth ? ageInYears(u.dateOfBirth, new Date()) < ADULT_AGE : false,
    };
  }

  /** O'quvchi -> o'qituvchi yoki vasiy. Faqat kattalar va tug'ilgan sanasi ma'lum bo'lganlar; qaytish yo'q. */
  async switchRole(actor: Actor, target: Role) {
    if (target !== Role.TEACHER && target !== Role.GUARDIAN) throw new BadRequestException('Role not allowed');
    if (actor.role !== Role.STUDENT) throw new ForbiddenException('Role change not allowed');
    if (!actor.ageKnown) throw new ForbiddenException('Date of birth required');
    if (actor.isMinor) throw new ForbiddenException('Adults only');
    await this.prisma.user.update({ where: { id: actor.id }, data: { role: target } });
    await this.audit.log(actor, { action: 'account.role_switch', targetType: 'User', targetId: actor.id, metadata: { from: actor.role, to: target } });
    return { role: target };
  }

  async listAudit(skip: number, take: number, action?: string) {
    return this.prisma.auditLog.findMany({
      where: action ? { action } : undefined,
      orderBy: { createdAt: 'desc' },
      skip,
      take: Math.min(take, 100),
    });
  }
}
