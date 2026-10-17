import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../common/actor';
import { ClockService } from '../common/clock';
import { displayName } from '../booking/booking-rules';
import { detectContactInfo } from '../safety/contact-info';

export const COMMENT_MAX_CHARS = 500;

/**
 * Ommaviy izohlar: istalgan foydalanuvchi (o'qituvchining o'zidan va boshqa o'qituvchilardan tashqari) bir marta yozadi.
 * Ro'yxatda har bir izoh "sobiq o'quvchi" (shu o'qituvchining darsi yoki sinfida bo'lgan) yoki "boshqalar" deb belgilanadi — ilova ikki guruhga ajratib ko'rsatadi.
 */
@Injectable()
export class CommentsService {
  constructor(private prisma: PrismaService, private clock: ClockService) {}

  private async publicProfile(profileId: string) {
    const p = await this.prisma.teacherProfile.findFirst({ where: { id: profileId, verificationStatus: 'VERIFIED', user: { status: 'ACTIVE' } }, select: { id: true, userId: true } });
    if (!p) throw new NotFoundException('Not found');
    return p;
  }

  private async exStudents(teacherProfileId: string, userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    const [b, e] = await Promise.all([
      this.prisma.booking.findMany({ where: { teacherId: teacherProfileId, studentId: { in: userIds }, status: 'COMPLETED' }, select: { studentId: true } }),
      this.prisma.classEnrollment.findMany({ where: { pupilId: { in: userIds }, class: { teacherId: teacherProfileId } }, select: { pupilId: true } }),
    ]);
    return new Set([...b.map((x) => x.studentId), ...e.map((x) => x.pupilId)]);
  }

  async list(actor: Actor, profileId: string, page = 1) {
    await this.publicProfile(profileId);
    const take = 30;
    const rows = await this.prisma.teacherComment.findMany({ where: { teacherId: profileId, hidden: false }, orderBy: { createdAt: 'desc' }, skip: (Math.max(1, page) - 1) * take, take });
    const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.authorId) } }, select: { id: true, name: true } });
    const names = new Map(users.map((u) => [u.id, u.name]));
    const ex = await this.exStudents(profileId, rows.map((r) => r.authorId));
    const mine = await this.prisma.teacherComment.findUnique({ where: { teacherId_authorId: { teacherId: profileId, authorId: actor.id } }, select: { id: true, text: true, rating: true } });
    const agg = await this.prisma.teacherComment.aggregate({ where: { teacherId: profileId, hidden: false, rating: { not: null } }, _count: { _all: true }, _avg: { rating: true } });
    // former pupils first, newest first inside each group
    const items = rows.map((r) => ({ id: r.id, text: r.text, rating: r.rating, at: r.createdAt, author: displayName(names.get(r.authorId) ?? null, true), exStudent: ex.has(r.authorId), mine: r.authorId === actor.id }));
    items.sort((a, b) => Number(b.exStudent) - Number(a.exStudent));
    return { items, mine: mine ? { id: mine.id, text: mine.text, rating: mine.rating } : null, summary: { count: agg._count._all, average: agg._avg.rating === null ? null : Math.round(agg._avg.rating * 100) / 100 } };
  }

  async write(actor: Actor, profileId: string, textIn: string, rating: number) {
    const p = await this.publicProfile(profileId);
    if (p.userId === actor.id) throw new ForbiddenException('You cannot comment on your own profile');
    if (actor.role === 'TEACHER') throw new ForbiddenException('Teachers cannot comment on other teachers');
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new BadRequestException('Rating must be 1..5');
    const text = textIn.trim();
    if (text.length < 3) throw new BadRequestException('Write a few words');
    if (text.length > COMMENT_MAX_CHARS) throw new BadRequestException('Comment too long');
    if (detectContactInfo(text).found) throw new BadRequestException({ message: "Comments are public: please don't include phone numbers or links", code: 'CONTACT_INFO_NOT_ALLOWED' });
    const now = this.clock.now();
    const row = await this.prisma.teacherComment.upsert({
      where: { teacherId_authorId: { teacherId: profileId, authorId: actor.id } },
      create: { teacherId: profileId, authorId: actor.id, text, rating, createdAt: now },
      update: { text, rating, editedAt: now, hidden: false },
    });
    return { id: row.id };
  }

  async removeMine(actor: Actor, profileId: string) {
    await this.publicProfile(profileId);
    await this.prisma.teacherComment.deleteMany({ where: { teacherId: profileId, authorId: actor.id } });
    return { ok: true };
  }
}
