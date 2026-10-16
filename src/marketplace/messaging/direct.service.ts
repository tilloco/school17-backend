import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor, ADULT_AGE, ageInYears } from '../common/actor';
import { ClockService } from '../common/clock';
import { displayName } from '../booking/booking-rules';
import { LegalService } from '../legal/legal.service';
import { BlocksService } from '../safety/blocks.service';
import { MessagingService } from './messaging.service';

/**
 * To'g'ridan-to'g'ri yozishmalar, bron bo'lmasa ham:
 *  - umumiy sinfdagilar (o'qituvchi, sinfdoshlar) darrov yoza oladi;
 *  - boshqa kattalar @nom bilan topilib "xabar so'rovi" yuboradi (qabul qilinguncha bitta xabar);
 *  - 18 yoshgacha bo'lganlar faqat o'zlarining o'qituvchisi bilan (sinfdoshlar bilan ham, begonalar bilan ham emas).
 */
@Injectable()
export class DirectService {
  constructor(private prisma: PrismaService, private clock: ClockService, private legal: LegalService, private blocks: BlocksService, private messaging: MessagingService) {}

  private isMinor(dob: Date | null) {
    return !dob || ageInYears(dob, this.clock.now()) < ADULT_AGE;
  }

  private async blockedEitherWay(a: string, b: string) {
    return !!(await this.prisma.userBlock.findFirst({ where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] }, select: { id: true } }));
  }

  /** Ikki kishi o'rtasidagi aloqa: o'qituvchi↔o'quvchi (sinf yoki bron), sinfdosh, yoki yo'q. */
  private async relation(a: { id: string; role: Role }, b: { id: string; role: Role }): Promise<'teacher-pupil' | 'classmates' | 'none'> {
    const teacherPupil = async (teacherId: string, pupilId: string) => {
      const [c, bk, th] = await Promise.all([
        this.prisma.classEnrollment.findFirst({ where: { pupilId, status: 'ACTIVE', class: { teacher: { userId: teacherId } } }, select: { id: true } }),
        this.prisma.booking.findFirst({ where: { studentId: pupilId, teacher: { userId: teacherId }, status: { in: ['REQUESTED', 'CONFIRMED', 'COMPLETED'] } }, select: { id: true } }),
        this.prisma.chatThread.findFirst({ where: { teacherUserId: teacherId, studentUserId: pupilId }, select: { id: true } }),
      ]);
      return !!(c || bk || th);
    };
    if (a.role === Role.TEACHER && b.role !== Role.TEACHER && (await teacherPupil(a.id, b.id))) return 'teacher-pupil';
    if (b.role === Role.TEACHER && a.role !== Role.TEACHER && (await teacherPupil(b.id, a.id))) return 'teacher-pupil';
    const mine = await this.prisma.classEnrollment.findMany({ where: { pupilId: a.id, status: 'ACTIVE' }, select: { classId: true } });
    if (mine.length && (await this.prisma.classEnrollment.findFirst({ where: { pupilId: b.id, status: 'ACTIVE', classId: { in: mine.map((x) => x.classId) } }, select: { id: true } }))) return 'classmates';
    return 'none';
  }

  /** Suhbatni ochadi yoki mavjudini qaytaradi. */
  async open(actor: Actor, userId: string) {
    if (userId === actor.id) throw new BadRequestException('You cannot message yourself');
    const other = await this.prisma.user.findFirst({ where: { id: userId, status: 'ACTIVE', role: { not: Role.ADMIN } }, select: { id: true, role: true, dateOfBirth: true, username: true, dmRequests: true } });
    if (!other) throw new NotFoundException('Not found');
    await this.legal.assertTerms(actor);
    if (await this.blockedEitherWay(actor.id, other.id)) throw new NotFoundException('Not found');
    await this.blocks.assertNotBlocked(actor.id, other.id);
    const me = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { id: true, role: true, dateOfBirth: true } });
    const rel = await this.relation(me, other);
    const minor = this.isMinor(me.dateOfBirth) || this.isMinor(other.dateOfBirth);
    if (minor && rel !== 'teacher-pupil') throw new ForbiddenException({ message: 'Pupils under 18 can message only their own teacher', code: 'MINOR_RESTRICTED' });
    // Tanish bo'lmagan odamga: faqat topish mumkin bo'lgan (@nomi bor) hisob yoki tasdiqlangan o'qituvchi
    if (rel === 'none' && !other.username && other.role !== Role.TEACHER) throw new NotFoundException('Not found');

    // Tomonlar: o'qituvchi "teacher" ustunida; aks holda id bo'yicha tartiblanadi (ikki yo'nalishda bitta suhbat)
    let teacherUserId: string;
    let studentUserId: string;
    if (me.role === Role.TEACHER && other.role !== Role.TEACHER) { teacherUserId = me.id; studentUserId = other.id; }
    else if (other.role === Role.TEACHER && me.role !== Role.TEACHER) { teacherUserId = other.id; studentUserId = me.id; }
    else [teacherUserId, studentUserId] = me.id < other.id ? [me.id, other.id] : [other.id, me.id];

    const existing = await this.prisma.chatThread.findUnique({ where: { teacherUserId_studentUserId: { teacherUserId, studentUserId } } });
    const thread = existing ?? (await this.prisma.chatThread.create({ data: { teacherUserId, studentUserId, status: rel === 'none' || (rel === 'classmates' && other.dmRequests) ? 'REQUEST' : 'ACTIVE', requestedById: actor.id } }));
    return (await this.messaging.list(actor)).find((v) => v.id === thread.id) ?? { id: thread.id };
  }

  /** @nom bo'yicha qidirish: faqat kattalar, kamida 3 harf, nom boshidan. */
  async search(actor: Actor, qIn: string) {
    const q = qIn.trim().replace(/^@/, '').toLowerCase().slice(0, 20);
    if (q.length < 3) return [];
    const cutoff = new Date(this.clock.now().getTime() - ADULT_AGE * 365.25 * 86_400_000);
    const rows = await this.prisma.user.findMany({
      where: { status: 'ACTIVE', role: { not: Role.ADMIN }, id: { not: actor.id }, username: { startsWith: q }, dateOfBirth: { lte: cutoff } },
      orderBy: { username: 'asc' }, take: 10, select: { id: true, name: true, username: true, role: true, avatarFileId: true },
    });
    const blocks = await this.prisma.userBlock.findMany({ where: { OR: [{ blockerId: actor.id }, { blockedId: actor.id }] }, select: { blockerId: true, blockedId: true } });
    const hidden = new Set(blocks.flatMap((b) => [b.blockerId, b.blockedId]));
    return rows.filter((r) => !hidden.has(r.id)).map((r) => ({ userId: r.id, name: r.name, username: r.username, role: r.role, hasPhoto: !!r.avatarFileId }));
  }

  /** Sinflaringizdagi odamlar: o'qituvchilar va sinfdoshlar (18 yoshgacha bo'lganlarga faqat o'qituvchilar). */
  async contacts(actor: Actor) {
    const me = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { dateOfBirth: true, role: true } });
    const minor = this.isMinor(me.dateOfBirth);
    const out = new Map<string, { userId: string; name: string; role: string; hasPhoto: boolean; classes: string[] }>();
    const add = (u: { id: string; name: string | null; role: string; dateOfBirth: Date | null; avatarFileId: string | null }, cls: string) => {
      if (u.id === actor.id) return;
      const cur = out.get(u.id) ?? { userId: u.id, name: displayName(u.name, this.isMinor(u.dateOfBirth)), role: u.role, hasPhoto: !!u.avatarFileId, classes: [] };
      cur.classes.push(cls);
      out.set(u.id, cur);
    };
    const sel = { id: true, name: true, role: true, dateOfBirth: true, avatarFileId: true } as const;
    if (me.role === Role.TEACHER) {
      const rows = await this.prisma.classEnrollment.findMany({ where: { status: 'ACTIVE', class: { teacher: { userId: actor.id }, status: 'ACTIVE' } }, take: 500, select: { class: { select: { title: true } }, pupil: { select: sel } } });
      for (const r of rows) add(r.pupil, r.class.title);
    } else {
      const mine = await this.prisma.classEnrollment.findMany({ where: { pupilId: actor.id, status: 'ACTIVE', class: { status: 'ACTIVE' } }, select: { classId: true, class: { select: { title: true, teacher: { select: { user: { select: sel } } } } } } });
      for (const m of mine) add(m.class.teacher.user, m.class.title);
      if (!minor && mine.length) {
        const mates = await this.prisma.classEnrollment.findMany({ where: { status: 'ACTIVE', classId: { in: mine.map((m) => m.classId) }, pupilId: { not: actor.id } }, take: 500, select: { class: { select: { title: true } }, pupil: { select: sel } } });
        for (const r of mates) if (!this.isMinor(r.pupil.dateOfBirth)) add(r.pupil, r.class.title);
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
