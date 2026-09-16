import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export enum PremiumGrantSource {
  PAYMENT = 'PAYMENT',
  REFERRAL_BONUS = 'REFERRAL_BONUS',
  ADMIN_GRANT = 'ADMIN_GRANT',
}

// Premium bilan bog'liq BARCHA joy (to'lov webhook'i, referral bonusi, admin panel)
// shu servisdan foydalanishi kerak - shunda premium muddatini hisoblash logikasi
// bitta joyda bo'ladi va hech qayerda takrorlanmaydi/chalkashmaydi.
@Injectable()
export class PremiumService {
  constructor(private prisma: PrismaService) {}

  // Premium muddatini uzaytiradi. Agar foydalanuvchida hali tugamagan premium bo'lsa,
  // yangi muddat SHU tugash sanasiga qo'shiladi (masalan hali 10 kuni bor + 1 oy sotib olsa,
  // yo'qotmaydi). Agar premium yo'q yoki muddati o'tgan bo'lsa, bugundan boshlab hisoblanadi.
  async extendPremium(userId: string, months: number, source: PremiumGrantSource) {
    if (months <= 0) throw new Error('months musbat son bo\'lishi kerak');

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const now = new Date();
    const base = user.premiumExpiresAt && user.premiumExpiresAt > now ? user.premiumExpiresAt : now;
    const newExpiry = new Date(base);
    newExpiry.setMonth(newExpiry.getMonth() + months);

    const [updatedUser] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { isPremium: true, premiumExpiresAt: newExpiry },
      }),
      this.prisma.premiumGrant.create({
        data: { userId, months, source },
      }),
    ]);

    return updatedUser;
  }

  // Premium holatini (haqiqatan ham amal qilyaptimi) tekshiradi. isPremium=true bo'lsa-da
  // muddati o'tgan bo'lishi mumkin, shuning uchun har doim shu funksiya orqali tekshirish kerak.
isActive(user: { isPremium: boolean; premiumExpiresAt: Date | null }): boolean {
  // VAQTINCHALIK: to'lov tizimi hali tayyor emas, shuning uchun test davrida
  // BARCHA foydalanuvchilar uchun Premium ochiq. To'lov sahifasi tayyor bo'lgach,
  // shu qatorni o'chirib, pastdagi asl logikani qaytaring:
  return true;

  // return user.isPremium && (!user.premiumExpiresAt || user.premiumExpiresAt > new Date());
}

  // Har kecha cron orqali chaqirilishi mumkin: muddati o'tgan lekin hali isPremium=true
  // bo'lib turgan foydalanuvchilarni "false" qilib qo'yadi (dashboard/limitlar to'g'ri ishlashi uchun).
  async deactivateExpired() {
    const result = await this.prisma.user.updateMany({
      where: { isPremium: true, premiumExpiresAt: { lt: new Date() } },
      data: { isPremium: false },
    });
    return result.count;
  }
}
