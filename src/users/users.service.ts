import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { streak: true },
    });
    if (!user) throw new NotFoundException('Foydalanuvchi topilmadi');
    return user;
  }

  // Onboarding'da (ism + imtihon sanasi) va keyinchalik profil sozlamalarida ishlatiladi
  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.examDate !== undefined ? { examDate: new Date(dto.examDate) } : {}),
      },
    });
    return user;
  }

  // Yangi avatar saqlangach chaqiriladi: user.avatarUrl yangilanadi va eskisi
  // (agar bo'lsa) diskdan o'chiriladi - shunda ishlatilmayotgan fayllar to'planib qolmaydi
  async updateAvatar(userId: string, file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException("Rasm fayli yuborilmadi (\"avatar\" maydonida)");

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Foydalanuvchi topilmadi');

    const newUrl = `/uploads/avatars/${file.filename}`;

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: newUrl },
    });

    if (user.avatarUrl && user.avatarUrl.startsWith('/uploads/avatars/')) {
      const oldPath = join(process.cwd(), user.avatarUrl);
      await unlink(oldPath).catch(() => undefined); // eski fayl topilmasa ham davom etamiz
    }

    return { avatarUrl: updated.avatarUrl };
  }

  // Dashboard uchun: umumiy progress foizi, streak, zaif mavzular
  async getDashboard(userId: string) {
    const totalLessons = await this.prisma.lesson.count();
    const completedLessons = await this.prisma.userProgress.count({
      where: { userId },
    });

    const streak = await this.prisma.streak.findUnique({ where: { userId } });

    // Har bir darsning to'g'ri javob foizini hisoblab, eng past foizlilarini "zaif mavzu" deb belgilaymiz
    const answers = await this.prisma.userAnswer.findMany({
      where: { userId },
      include: { question: { include: { lesson: { include: { week: { include: { module: true } } } } } } },
    });

    const byModule: Record<string, { correct: number; total: number; title: string }> = {};
    for (const a of answers) {
      const moduleTitle = a.question.lesson.week.module.title;
      if (!byModule[moduleTitle]) byModule[moduleTitle] = { correct: 0, total: 0, title: moduleTitle };
      byModule[moduleTitle].total += 1;
      if (a.isCorrect) byModule[moduleTitle].correct += 1;
    }

    const weakTopics = Object.values(byModule)
      .map((m) => ({ title: m.title, correctPercent: Math.round((m.correct / m.total) * 100) }))
      .sort((a, b) => a.correctPercent - b.correctPercent)
      .slice(0, 3);

    return {
      progressPercent: totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0,
      completedLessons,
      totalLessons,
      streak: streak?.currentCount ?? 0,
      weakTopics,
    };
  }
    // Xabar yozish uchun foydalanuvchini ism yoki email bo'yicha qidirish
  async searchUsers(currentUserId: string, query: string) {
    if (!query.trim()) return [];

    const users = await this.prisma.user.findMany({
      where: {
        id: { not: currentUserId },
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { email: { contains: query, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
        avatarUrl: true,
      },
      take: 20,
    });

    return users;
  }
}
