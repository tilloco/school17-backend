import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ClockService } from '../common/clock';

export interface EnqueueOptions {
  dueAt?: Date;
  /** Bir xil (userId, dedupeKey) ikki marta yaratilmaydi — qayta urinishlarda dublikat bo'lmasligi uchun */
  dedupeKey?: string;
}

/**
 * Bildirishnomalar outbox'i. Yetkazish kanallari (email / push) S11 da ulanadi; hozircha IN_APP ro'yxat.
 * `data` ichiga maxfiy ma'lumot (token, parol) yozilmaydi — faqat id'lar va vaqtlar.
 */
@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService, private clock: ClockService) {}

  async enqueue(userId: string, type: string, data: Record<string, unknown>, opts: EnqueueOptions = {}) {
    try {
      return await this.prisma.notification.create({
        data: { userId, type, data: data as Prisma.InputJsonValue, dueAt: opts.dueAt ?? this.clock.now(), createdAt: this.clock.now(), dedupeKey: opts.dedupeKey },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') return null; // dublikat dedupeKey
      throw e;
    }
  }

  /** Bekor qilingan bron uchun hali yuborilmagan eslatmalarni o'chiradi. */
  cancelPendingForBooking(bookingId: string) {
    return this.prisma.notification.deleteMany({
      where: { sentAt: null, dedupeKey: { startsWith: `booking:${bookingId}:reminder` } },
    });
  }

  listForUser(userId: string, take = 50, unreadOnly = false) {
    return this.prisma.notification.findMany({
      where: { userId, dueAt: { lte: this.clock.now() }, ...(unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(take, 100),
    });
  }

  async markRead(userId: string, id: string) {
    const r = await this.prisma.notification.updateMany({ where: { id, userId }, data: { readAt: new Date() } });
    return { updated: r.count };
  }
}
