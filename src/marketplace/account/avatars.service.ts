import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor, ADULT_AGE, ageInYears } from '../common/actor';
import { ClockService } from '../common/clock';
import { GuardianService } from '../guardian/guardian.service';

/**
 * Profil rasmi har bir foydalanuvchi uchun. Kim ko'radi:
 *  - o'zi; tasdiqlangan o'qituvchining rasmini hamma;
 *  - boshqalarning rasmini: ular bilan umumiy sinfda / bronda / suhbatda bo'lganlar;
 *  - 18 yoshgacha bo'lganlarning rasmini: faqat o'zi, vasiysi va ular bilan ishlaydigan o'qituvchi (sinfdoshlar ko'rmaydi).
 */
@Injectable()
export class AvatarsService {
  constructor(private prisma: PrismaService, private clock: ClockService, private guardians: GuardianService) {}

  async set(actor: Actor, fileId: string) {
    const f = await this.prisma.storedFile.findFirst({ where: { id: fileId, ownerId: actor.id, deletedAt: null } });
    if (!f) throw new NotFoundException('File not found');
    if (f.purpose !== 'AVATAR') throw new BadRequestException('File has wrong purpose');
    if (f.status !== 'READY' || !f.thumbKey) throw new ConflictException('File is not a ready image');
    await this.prisma.user.update({ where: { id: actor.id }, data: { avatarFileId: f.id } });
    if (actor.role === Role.TEACHER) await this.prisma.teacherProfile.updateMany({ where: { userId: actor.id }, data: { photoFileId: f.id } });
    return { hasPhoto: true };
  }

  async remove(actor: Actor) {
    await this.prisma.user.update({ where: { id: actor.id }, data: { avatarFileId: null } });
    if (actor.role === Role.TEACHER) await this.prisma.teacherProfile.updateMany({ where: { userId: actor.id }, data: { photoFileId: null } });
    return { hasPhoto: false };
  }

  private async teachesOrWorksWith(teacherUserId: string, pupilId: string): Promise<boolean> {
    const [c, b, t] = await Promise.all([
      this.prisma.classEnrollment.findFirst({ where: { pupilId, class: { teacher: { userId: teacherUserId } } }, select: { id: true } }),
      this.prisma.booking.findFirst({ where: { studentId: pupilId, teacher: { userId: teacherUserId } }, select: { id: true } }),
      this.prisma.chatThread.findFirst({ where: { OR: [{ teacherUserId, studentUserId: pupilId }, { teacherUserId: pupilId, studentUserId: teacherUserId }] }, select: { id: true } }),
    ]);
    return !!(c || b || t);
  }

  private async classmates(a: string, b: string): Promise<boolean> {
    const mine = await this.prisma.classEnrollment.findMany({ where: { pupilId: a, status: 'ACTIVE' }, select: { classId: true } });
    if (!mine.length) return false;
    return !!(await this.prisma.classEnrollment.findFirst({ where: { pupilId: b, status: 'ACTIVE', classId: { in: mine.map((m) => m.classId) } }, select: { id: true } }));
  }

  /** Rasm faylini qaytaradi yoki 404 (mavjud emas / ruxsat yo'q — farqlanmaydi). */
  async fileFor(actor: Actor, userId: string) {
    const u = await this.prisma.user.findFirst({ where: { id: userId, status: 'ACTIVE', avatarFileId: { not: null } }, select: { id: true, avatarFileId: true, role: true, dateOfBirth: true } });
    if (!u?.avatarFileId) throw new NotFoundException('Not found');
    let ok = u.id === actor.id;
    if (!ok) {
      const publicTeacher = u.role === Role.TEACHER && !!(await this.prisma.teacherProfile.findFirst({ where: { userId: u.id, verificationStatus: 'VERIFIED' }, select: { id: true } }));
      const minor = !u.dateOfBirth || ageInYears(u.dateOfBirth, this.clock.now()) < ADULT_AGE;
      if (publicTeacher) ok = true;
      else if (minor) {
        ok = (actor.role === Role.TEACHER && (await this.teachesOrWorksWith(actor.id, u.id))) || (actor.role === Role.GUARDIAN && (await this.guardians.isActiveGuardianOf(actor.id, u.id)));
      } else {
        ok = (await this.classmates(actor.id, u.id)) || (await this.teachesOrWorksWith(actor.id, u.id)) || (await this.teachesOrWorksWith(u.id, actor.id));
      }
    }
    if (!ok) throw new NotFoundException('Not found');
    const f = await this.prisma.storedFile.findFirst({ where: { id: u.avatarFileId, deletedAt: null, status: 'READY' } });
    if (!f?.thumbKey) throw new NotFoundException('Not found');
    return f;
  }
}
