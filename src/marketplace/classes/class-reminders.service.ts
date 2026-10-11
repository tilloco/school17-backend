import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ClockService } from '../common/clock';
import { GuardianService } from '../guardian/guardian.service';
import { NotificationsService } from '../notifications/notifications.service';

const DAY_MS = 86_400_000;
const REMINDER_TYPES = ['class.reminder_day', 'class.reminder_soon'];
const HORIZON_DAYS = 35;

/**
 * Dars eslatmalari (C2, sinflar uchun): sessiyadan 1 kun va 30 daqiqa oldin o'qituvchiga, o'quvchiga va (voyaga yetmagan bo'lsa) vasiyga.
 * Takrorlanmaydi: (foydalanuvchi, dedupeKey) noyob. Soat ClockService orqali. Bekor qilingan sessiya/chiqarilgan o'quvchi uchun yuborilmagan eslatmalar o'chiriladi.
 * Hozircha faqat push/ilova ichida (Telegram C1 qo'shilgach o'sha kanal ham ulanadi).
 */
@Injectable()
export class ClassRemindersService {
  constructor(private prisma: PrismaService, private clock: ClockService, private notifications: NotificationsService, private guardians: GuardianService) {}

  private async recipients(classId: string): Promise<string[]> {
    const c = await this.prisma.class.findUnique({ where: { id: classId }, select: { teacher: { select: { userId: true } } } });
    if (!c) return [];
    const pupils = await this.prisma.classEnrollment.findMany({ where: { classId, status: 'ACTIVE' }, select: { pupilId: true } });
    const out = new Set<string>([c.teacher.userId]);
    for (const p of pupils) {
      out.add(p.pupilId);
      for (const g of await this.guardians.guardianIdsOf(p.pupilId)) out.add(g);
    }
    return [...out];
  }

  /** Kelgusi sessiyalar uchun yetishmayotgan eslatmalarni yaratadi (idempotent) */
  async sync(classId: string): Promise<number> {
    const now = this.clock.now();
    const cls = await this.prisma.class.findUnique({ where: { id: classId }, select: { status: true } });
    if (!cls || cls.status !== 'ACTIVE') return 0;
    const sessions = await this.prisma.classSession.findMany({ where: { classId, status: { in: ['SCHEDULED', 'LOBBY'] }, startAt: { gt: now, lt: new Date(now.getTime() + HORIZON_DAYS * DAY_MS) } }, select: { id: true, startAt: true } });
    if (!sessions.length) return 0;
    const users = await this.recipients(classId);
    let n = 0;
    for (const s of sessions) {
      const data = { classId, sessionId: s.id };
      for (const u of users) {
        const dayAt = new Date(s.startAt.getTime() - DAY_MS);
        const halfAt = new Date(s.startAt.getTime() - 30 * 60_000);
        if (dayAt > now && (await this.notifications.enqueue(u, 'class.reminder_day', data, { dueAt: dayAt, dedupeKey: `clsrem:${s.id}:day` }))) n++;
        if (halfAt > now && (await this.notifications.enqueue(u, 'class.reminder_soon', data, { dueAt: halfAt, dedupeKey: `clsrem:${s.id}:30m` }))) n++;
      }
    }
    return n;
  }

  /** Bekor qilingan sessiya: hali yuborilmagan eslatmalar o'chiriladi */
  async cancelSession(sessionId: string) {
    return this.prisma.notification.deleteMany({ where: { sentAt: null, type: { in: REMINDER_TYPES }, data: { path: ['sessionId'], equals: sessionId } } });
  }
  /** Sinf bekor qilindi yoki foydalanuvchilar sinfdan chiqdi */
  async cancelClass(classId: string, userIds?: string[]) {
    return this.prisma.notification.deleteMany({ where: { sentAt: null, type: { in: REMINDER_TYPES }, ...(userIds ? { userId: { in: userIds } } : {}), data: { path: ['classId'], equals: classId } } });
  }
  async cancelForPupil(classId: string, pupilId: string) {
    const ids = [pupilId, ...(await this.guardians.guardianIdsOf(pupilId))];
    return this.cancelClass(classId, ids);
  }
}
