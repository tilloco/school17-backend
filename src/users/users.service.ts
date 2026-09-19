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

  // Dashboard uchun: topshirilgan mock imtihonlar soni
  async getDashboard(userId: string) {
    const EXAMS_GOAL = 10;
    const examsTaken = await this.prisma.examSession.count({
      where: { userId, status: 'COMPLETED' },
    });
    return { examsTaken, examsGoal: EXAMS_GOAL };
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

