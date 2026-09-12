import { Injectable, BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { ReferralService } from '../referral/referral.service';

const OTP_TTL_MS = 5 * 60 * 1000; // 5 daqiqa
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // bir emailga 60 soniyada 1 marta so'rov
const OTP_MAX_PER_HOUR = 5; // bir emailga soatiga maksimal nechta kod yuborish mumkin
const OTP_MAX_VERIFY_ATTEMPTS = 5; // bitta kod uchun noto'g'ri urinishlar limiti

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private email: EmailService,
    private jwt: JwtService,
    private config: ConfigService,
    private referral: ReferralService,
  ) {}

  // Kodni HMAC-SHA256 bilan hash qilamiz (pepper .env'da) - DB'da ochiq kod saqlanmaydi
  private hashCode(email: string, code: string): string {
    const pepper = this.config.get<string>('OTP_PEPPER');
    if (!pepper) throw new Error('OTP_PEPPER .env da sozlanmagan');
    return createHmac('sha256', pepper).update(`${email.toLowerCase()}:${code}`).digest('hex');
  }

  // 1-QADAM: foydalanuvchi emailini kiritadi -> 6 xonali kod yaratamiz,
  // hash qilib bazaga saqlaymiz va email orqali yuboramiz.
  async requestOtp(rawEmail: string): Promise<{ message: string }> {
    const email = rawEmail.trim().toLowerCase();
    const now = new Date();

    const lastOtp = await this.prisma.otpCode.findFirst({
      where: { email },
      orderBy: { createdAt: 'desc' },
    });

    if (lastOtp && now.getTime() - lastOtp.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
      const waitSec = Math.ceil(
        (OTP_RESEND_COOLDOWN_MS - (now.getTime() - lastOtp.createdAt.getTime())) / 1000,
      );
      throw new HttpException(
        { code: 'OTP_COOLDOWN', message: `Iltimos ${waitSec} soniyadan keyin qayta urinib ko'ring` },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const countLastHour = await this.prisma.otpCode.count({
      where: { email, createdAt: { gte: hourAgo } },
    });

    if (countLastHour >= OTP_MAX_PER_HOUR) {
      throw new HttpException(
        { code: 'OTP_HOURLY_LIMIT', message: "Bu email uchun urinishlar soni tugadi, keyinroq qayta urining" },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = randomInt(100000, 1000000).toString();
    const expiresAt = new Date(now.getTime() + OTP_TTL_MS);

    await this.prisma.otpCode.create({
      data: { email, codeHash: this.hashCode(email, code), expiresAt },
    });

    await this.email.sendOtp(email, code);

    return { message: 'Tasdiqlash kodi yuborildi' };
  }

  // 2-QADAM: foydalanuvchi kodni kiritadi -> tekshiramiz, agar to'g'ri bo'lsa
  // foydalanuvchini topamiz yoki yangi yaratamiz, JWT token qaytaramiz.
  async verifyOtp(
    rawEmail: string,
    code: string,
    name?: string,
    referredByCode?: string,
  ): Promise<{ accessToken: string; isNewUser: boolean }> {
    const email = rawEmail.trim().toLowerCase();

    const otp = await this.prisma.otpCode.findFirst({
      where: { email, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp) {
      throw new BadRequestException("Kod noto'g'ri yoki muddati o'tgan");
    }

    if (otp.attempts >= OTP_MAX_VERIFY_ATTEMPTS) {
      await this.prisma.otpCode.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
      throw new HttpException(
        { code: 'OTP_TOO_MANY_ATTEMPTS', message: "Urinishlar soni tugadi. Yangi kod so'rang" },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const isMatch = this.safeCompare(otp.codeHash, this.hashCode(email, code));

    if (!isMatch) {
      await this.prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      throw new BadRequestException("Kod noto'g'ri yoki muddati o'tgan");
    }

    await this.prisma.otpCode.update({
      where: { id: otp.id },
      data: { usedAt: new Date() },
    });

    let user = await this.prisma.user.findUnique({ where: { email } });
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      user = await this.prisma.user.create({
        data: {
          email,
          name,
          referredByCode,
          referralCode: this.generateReferralCode(),
          streak: { create: { currentCount: 0 } },
        },
      });

      if (referredByCode) {
        await this.referral.registerReferral(referredByCode, user.id);
      }
    }

    const accessToken = this.jwt.sign({ sub: user.id, email: user.email });
    return { accessToken, isNewUser };
  }

  private safeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  private generateReferralCode(): string {
    return randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
  }
}