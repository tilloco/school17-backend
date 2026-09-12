import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PremiumService, PremiumGrantSource } from '../premium/premium.service';

// Har bir sotib olingan premium uchun referral qiluvchiga tushadigan naqd bonus (so'm),
// "hamyon" balansiga qo'shiladi va keyinchalik yechib olish so'rovi qilinishi mumkin.
export const REFERRAL_CASH_REWARD = 5000;

// Har REFERRAL_FREE_PREMIUM_THRESHOLD ta do'stni (pullik bo'lishi shart emas) taklif qilsa,
// referral qiluvchiga avtomatik REFERRAL_FREE_PREMIUM_MONTHS oylik bepul premium beriladi.
// Modulo bilan hisoblangani uchun bu 3-chi, 6-chi, 9-chi... do'stda takrorlanadi.
export const REFERRAL_FREE_PREMIUM_THRESHOLD = 3;
export const REFERRAL_FREE_PREMIUM_MONTHS = 1;

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private prisma: PrismaService,
    private premium: PremiumService,
  ) {}

  // AuthService.verifyOtp yangi foydalanuvchi yaratganda chaqiradi.
  // Xato bo'lsa ham (masalan referral kod noto'g'ri) ro'yxatdan o'tishni to'xtatmaydi -
  // faqat referral bog'lanishi o'tkazib yuboriladi.
  async registerReferral(referrerCode: string, newUserId: string): Promise<void> {
    const code = referrerCode.trim().toUpperCase();
    const referrer = await this.prisma.user.findUnique({ where: { referralCode: code } });

    if (!referrer) {
      this.logger.warn(`Ro'yxatdan o'tishda noma'lum referral kod ishlatildi: ${code}`);
      return;
    }
    if (referrer.id === newUserId) {
      // Nazariy jihatdan yuz berishi mumkin emas (yangi user hali o'z kodini bilmaydi),
      // lekin ikkinchi himoya qatlami sifatida qoldiramiz.
      return;
    }

    try {
      await this.prisma.referral.create({
        data: { referrerId: referrer.id, referredUserId: newUserId, status: 'PENDING' },
      });
    } catch (e) {
      // referredUserId @unique - bitta foydalanuvchi faqat bitta marta referral qilingan
      // bo'lishi mumkin. Bu yerga tushish deyarli mumkin emas (yangi user), shunchaki
      // kutilmagan holatni yutib yuboramiz, ro'yxatdan o'tishni buzmaslik uchun.
      this.logger.error(`Referral yozuvini yaratib bo'lmadi: ${e}`);
      return;
    }

    const totalReferred = await this.prisma.referral.count({ where: { referrerId: referrer.id } });

    if (totalReferred > 0 && totalReferred % REFERRAL_FREE_PREMIUM_THRESHOLD === 0) {
      await this.premium.extendPremium(
        referrer.id,
        REFERRAL_FREE_PREMIUM_MONTHS,
        PremiumGrantSource.REFERRAL_BONUS,
      );
      this.logger.log(
        `${referrer.id}: ${totalReferred}-chi taklif - ${REFERRAL_FREE_PREMIUM_MONTHS} oylik bepul premium berildi`,
      );
    }
  }

  // Payment modul (5-bosqich) premium to'lovi muvaffaqiyatli bo'lganda shu funksiyani chaqiradi.
  // Referral bir marotaba (birinchi premium xariddan) mukofotlanadi - keyingi obuna
  // uzaytirishlarida qayta pul berilmaydi.
  // To'lov muvaffaqiyatli bo'lganda chaqiriladi (webhook'dan, 5-bosqichda ulanadi).
  // Agar bu foydalanuvchi kimningdir referral orqali kelgan bo'lsa va hali mukofot
  // berilmagan bo'lsa - referral qiluvchining hamyoniga pul qo'shiladi.
  //
  // XAVFSIZLIK: Click/Payme kabi to'lov provayderlari webhook'ni ba'zan qayta yuboradi
  // (tarmoq xatosi, retry va h.k.), shuning uchun bu funksiya bir necha marta ketma-ket
  // yoki bir vaqtda chaqirilishi mumkin deb hisoblanadi. "O'qib-tekshirib-yozish" o'rniga
  // status='PENDING' shartli atomik update ishlatiladi - shu tufayli ikkita parallel
  // chaqiruv bo'lsa ham faqat BITTASI mukofotni beradi (ikkinchisi count=0 ko'radi va chiqib ketadi).
  async rewardOnPremiumPurchase(referredUserId: string): Promise<void> {
    const referral = await this.prisma.referral.findUnique({ where: { referredUserId } });
    if (!referral) return;

    const claimed = await this.prisma.referral.updateMany({
      where: { id: referral.id, status: 'PENDING' }, // faqat hali mukofotlanmagan bo'lsa
      data: { status: 'REWARDED', rewardAmount: REFERRAL_CASH_REWARD },
    });
    if (claimed.count === 0) return; // boshqa chaqiruv allaqachon mukofotlagan - idempotent

    await this.prisma.user.update({
      where: { id: referral.referrerId },
      data: { walletBalance: { increment: REFERRAL_CASH_REWARD } },
    });

    this.logger.log(`Referral mukofoti berildi: referrer=${referral.referrerId} +${REFERRAL_CASH_REWARD} so'm`);
  }

  async getMyReferralStats(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const referrals = await this.prisma.referral.findMany({
      where: { referrerId: userId },
      include: {
        referredUser: { select: { name: true, email: true, isPremium: true, createdAt: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const progress = referrals.length % REFERRAL_FREE_PREMIUM_THRESHOLD;

    return {
      referralCode: user.referralCode,
      walletBalance: user.walletBalance,
      totalReferred: referrals.length,
      premiumConverted: referrals.filter((r) => r.status === 'REWARDED').length,
      milestoneProgress: progress === 0 && referrals.length > 0 ? REFERRAL_FREE_PREMIUM_THRESHOLD : progress,
      milestoneTarget: REFERRAL_FREE_PREMIUM_THRESHOLD,
      cashRewardPerPurchase: REFERRAL_CASH_REWARD,
      history: referrals.map((r) => ({
        name: r.referredUser.name ?? 'Foydalanuvchi',
              maskedEmail: maskEmail(r.referredUser.email),
        isPremium: r.referredUser.isPremium,
        status: r.status,
        joinedAt: r.referredUser.createdAt,
      })),
    };
  }

  // --- Hamyon / pul yechib olish ---

  // Summasi darhol walletBalance'dan ayiriladi (ikki marta so'rov yuborib bir xil pulni
  // ikki marta yechib olishning oldini olish uchun). Rad etilsa (REJECTED) pul qaytariladi.
  //
  // XAVFSIZLIK: balansni "o'qib - tekshirib - kamaytirish" o'rniga bitta atomik SQL
  // (updateMany + walletBalance >= amount sharti) ishlatiladi. Shunda ikkita so'rov bir
  // vaqtda kelsa ham (masalan foydalanuvchi tugmani ikki marta bossa), faqat bittasi
  // o'tadi - "race condition" orqali balansdan ortiqcha pul yechib olish mumkin emas.
  async requestWithdrawal(userId: string, amount: number) {
    const claimed = await this.prisma.user.updateMany({
      where: { id: userId, walletBalance: { gte: amount } },
      data: { walletBalance: { decrement: amount } },
    });

    if (claimed.count === 0) {
      throw new BadRequestException("Hamyoningizda yetarli mablag' yo'q");
    }

    return this.prisma.withdrawal.create({
      data: { userId, amount, status: 'PENDING' },
    });
  }

  async getMyWithdrawals(userId: string) {
    return this.prisma.withdrawal.findMany({
      where: { userId },
      orderBy: { requestedAt: 'desc' },
    });
  }

  // --- Admin (AdminJwtAuthGuard bilan himoyalangan - haqiqiy admin login orqali
  // panelga ko'chadi) ---

  async listWithdrawals(status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAID') {
    return this.prisma.withdrawal.findMany({
      where: status ? { status } : undefined,
          include: { user: { select: { name: true, email: true } } },
      orderBy: { requestedAt: 'asc' },
    });
  }

  async processWithdrawal(
    withdrawalId: string,
    newStatus: 'APPROVED' | 'REJECTED' | 'PAID',
    note?: string,
  ) {
    const withdrawal = await this.prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal) throw new NotFoundException("So'rov topilmadi");

    // XAVFSIZLIK: status='PENDING' shartli atomik update - ikkita admin (yoki ikki marta
    // bosilgan tugma) bir xil so'rovni bir vaqtda tasdiqlasa/rad etsa, faqat BITTASI
    // o'tadi. count=0 bo'lsa - demak boshqa chaqiruv allaqachon ko'rib chiqqan.
    const claimed = await this.prisma.withdrawal.updateMany({
      where: { id: withdrawalId, status: 'PENDING' },
      data: { status: newStatus, note, processedAt: new Date() },
    });

    if (claimed.count === 0) {
      throw new ForbiddenException("Bu so'rov allaqachon ko'rib chiqilgan");
    }

    if (newStatus === 'REJECTED') {
      // Rad etilsa - ayirilgan pul foydalanuvchiga qaytariladi
      await this.prisma.user.update({
        where: { id: withdrawal.userId },
        data: { walletBalance: { increment: withdrawal.amount } },
      });
    }

    return this.prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
  }
}

function maskEmail(email: string): string {
  // user@example.com -> us***@example.com (to'liq emailni ko'rsatmaslik uchun)
  const [local, domain] = email.split('@');
  if (!domain || local.length < 2) return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}
