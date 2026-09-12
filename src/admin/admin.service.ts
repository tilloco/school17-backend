import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const PAGE_SIZE = 20;

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  async listUsers(params: { search?: string; status?: 'premium' | 'free' | 'all'; page?: number }) {
    const page = Math.max(1, params.page ?? 1);
    const now = new Date();

    const conditions: any[] = [];
    if (params.search) {
      conditions.push({
        OR: [{ name: { contains: params.search, mode: 'insensitive' } }, { email: { contains: params.search, mode: 'insensitive' } }],
      });
    }
    if (params.status === 'premium') {
      conditions.push({ isPremium: true }, { OR: [{ premiumExpiresAt: null }, { premiumExpiresAt: { gt: now } }] });
    } else if (params.status === 'free') {
      conditions.push({ OR: [{ isPremium: false }, { premiumExpiresAt: { lte: now } }] });
    }
    const where = conditions.length > 0 ? { AND: conditions } : {};

    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          name: true,
          email: true,
          avatarUrl: true,
          isPremium: true,
          premiumExpiresAt: true,
          walletBalance: true,
          examDate: true,
          createdAt: true,
          streak: { select: { currentCount: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    const items = users.map((u) => ({
      ...u,
      isPremiumActive: u.isPremium && (!u.premiumExpiresAt || u.premiumExpiresAt > now),
      streak: u.streak?.currentCount ?? 0,
    }));

    return { items, total, page, pageSize: PAGE_SIZE, totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
  }

  async getUserDetail(userId: string) {
    const now = new Date();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        streak: true,
        payments: { orderBy: { createdAt: 'desc' }, take: 10 },
        referralsMade: true,
        _count: { select: { progress: true, answers: true } },
      },
    });
    if (!user) throw new NotFoundException('Foydalanuvchi topilmadi');
    return { ...user, isPremiumActive: user.isPremium && (!user.premiumExpiresAt || user.premiumExpiresAt > now) };
  }

  async getStats() {
    const now = new Date();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [totalUsers, activePremium, newToday, dauToday, wau, successfulPayments] = await this.prisma.$transaction([
      this.prisma.user.count(),
      this.prisma.user.count({
        where: { isPremium: true, OR: [{ premiumExpiresAt: null }, { premiumExpiresAt: { gt: now } }] },
      }),
      this.prisma.user.count({ where: { createdAt: { gte: startOfToday } } }),
      this.prisma.userAnswer.findMany({
        where: { answeredAt: { gte: startOfToday } },
        distinct: ['userId'],
        select: { userId: true },
      }),
      this.prisma.userAnswer.findMany({
        where: { answeredAt: { gte: sevenDaysAgo } },
        distinct: ['userId'],
        select: { userId: true },
      }),
      this.prisma.payment.aggregate({ where: { status: 'SUCCESS' }, _sum: { amount: true } }),
    ]);

    return {
      totalUsers,
      activePremium,
      freeUsers: totalUsers - activePremium,
      newUsersToday: newToday,
      dailyActiveUsers: dauToday.length,
      weeklyActiveUsers: wau.length,
      totalRevenue: successfulPayments._sum.amount ?? 0,
    };
  }
}