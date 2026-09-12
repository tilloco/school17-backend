import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PremiumService } from '../premium/premium.service';

const FREE_QUESTIONS_PER_DAY = 3; // hozirgi Telegram bot bilan bir xil model

@Injectable()
export class QuizService {
  constructor(
    private prisma: PrismaService,
    private premium: PremiumService,
  ) {}

  private startOfToday(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // Foydalanuvchi savolga javob beradi. Premium bo'lmasa, kuniga 3 tadan keyin
  // 403 xato bilan to'lov ekranini ko'rsatish kerakligini bildiradi.
  async submitAnswer(userId: string, questionId: string, chosenIndex: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Foydalanuvchi topilmadi');

    const isPremiumActive = this.premium.isActive(user);

    if (!isPremiumActive) {
      const answeredToday = await this.prisma.userAnswer.count({
        where: { userId, answeredAt: { gte: this.startOfToday() } },
      });
      if (answeredToday >= FREE_QUESTIONS_PER_DAY) {
        throw new ForbiddenException({
          code: 'FREE_LIMIT_REACHED',
          message: `Bugungi ${FREE_QUESTIONS_PER_DAY} ta bepul savol tugadi. Premium sotib oling yoki ertaga qayting.`,
        });
      }
    }

    const question = await this.prisma.question.findUnique({ where: { id: questionId } });
    if (!question) throw new NotFoundException('Savol topilmadi');

    const isCorrect = chosenIndex === question.correctIndex;

    await this.prisma.userAnswer.create({
      data: { userId, questionId, chosenIndex, isCorrect },
    });

    return {
      isCorrect,
      correctIndex: question.correctIndex,
      explanation: question.explanation,
    };
  }

  // Dars tugagach chaqiriladi: progress belgilanadi va streak yangilanadi
  async completeLesson(userId: string, lessonId: string) {
    const lesson = await this.prisma.lesson.findUnique({ where: { id: lessonId } });
    if (!lesson) throw new NotFoundException('Dars topilmadi');

    await this.prisma.userProgress.upsert({
      where: { userId_lessonId: { userId, lessonId } },
      update: {},
      create: { userId, lessonId },
    });

    await this.updateStreak(userId);

    return { message: 'Dars yakunlandi' };
  }

  private async updateStreak(userId: string) {
    const today = this.startOfToday();
    const streak = await this.prisma.streak.findUnique({ where: { userId } });

    if (!streak) {
      await this.prisma.streak.create({ data: { userId, currentCount: 1, lastActiveDate: today } });
      return;
    }

    if (streak.lastActiveDate) {
      const last = new Date(streak.lastActiveDate);
      last.setHours(0, 0, 0, 0);
      const diffDays = Math.round((today.getTime() - last.getTime()) / (1000 * 60 * 60 * 24));

      if (diffDays === 0) return; // bugun allaqachon hisoblangan
      if (diffDays === 1) {
        await this.prisma.streak.update({
          where: { userId },
          data: { currentCount: { increment: 1 }, lastActiveDate: today },
        });
        return;
      }
    }

    // Ketma-ketlik uzilgan (1 kundan ko'p tanaffus) - qaytadan 1 dan boshlanadi
    await this.prisma.streak.update({
      where: { userId },
      data: { currentCount: 1, lastActiveDate: today },
    });
  }

  // Bugun nechta bepul savol ishlatilgani va nechtasi qolgani (mobil UI uchun foydali)
  async getFreeQuota(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Foydalanuvchi topilmadi');

    const isPremiumActive = this.premium.isActive(user);
    if (isPremiumActive) return { isPremium: true, remainingToday: null };

    const answeredToday = await this.prisma.userAnswer.count({
      where: { userId, answeredAt: { gte: this.startOfToday() } },
    });

    return {
      isPremium: false,
      remainingToday: Math.max(0, FREE_QUESTIONS_PER_DAY - answeredToday),
    };
  }
}
