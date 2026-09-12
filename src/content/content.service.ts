import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateModuleDto, CreateWeekDto, CreateLessonDto, CreateQuestionDto } from './dto/content.dto';

@Injectable()
export class ContentService {
  constructor(private prisma: PrismaService) {}

  // --- O'QISH (mobil ilova uchun, ochiq) ---

  // Fanlar/modullar ro'yxati, har biriga nechta hafta/dars borligi bilan
  async listModules() {
    return this.prisma.module.findMany({
      orderBy: { order: 'asc' },
      include: {
        weeks: {
          orderBy: { order: 'asc' },
          include: { lessons: { orderBy: { order: 'asc' }, select: { id: true, title: true, order: true } } },
        },
      },
    });
  }

  // Bitta darsning matni + savollari (correctIndex YASHIRIN - aldashning oldini olish uchun)
  async getLesson(lessonId: string) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: {
        questions: {
          select: { id: true, text: true, options: true }, // correctIndex va explanation qaytarilmaydi
        },
      },
    });
    if (!lesson) throw new NotFoundException('Dars topilmadi');
    return lesson;
  }

  // --- YOZISH (faqat admin, AdminJwtAuthGuard bilan himoyalangan) ---

  createModule(dto: CreateModuleDto) {
    return this.prisma.module.create({ data: dto });
  }

  createWeek(dto: CreateWeekDto) {
    return this.prisma.week.create({ data: dto });
  }

  createLesson(dto: CreateLessonDto) {
    return this.prisma.lesson.create({ data: dto });
  }

  createQuestion(dto: CreateQuestionDto) {
    // DTO faqat correctIndex >= 0 ekanini tekshiradi (options uzunligi dinamik bo'lgani
    // uchun class-validator darajasida bog'lab bo'lmaydi) - shu yerda qo'shimcha tekshiruv:
    // aks holda noto'g'ri indeks bilan savol saqlanib qolsa, mobil ilovada HECH QANDAY
    // variant "to'g'ri javob" sifatida belgilanmagan bo'lib chiqadi (foydalanuvchi hech
    // qachon to'g'ri javob berolmaydi) - xavfsizlik emas, lekin jiddiy "smoothness" nuqsoni.
    if (dto.correctIndex >= dto.options.length) {
      throw new BadRequestException("correctIndex options ro'yxati chegarasidan tashqarida");
    }
    return this.prisma.question.create({ data: dto });
  }

  async deleteLesson(id: string) {
    await this.prisma.lesson.delete({ where: { id } });
    return { message: "Dars o'chirildi" };
  }

  async deleteQuestion(id: string) {
    await this.prisma.question.delete({ where: { id } });
    return { message: "Savol o'chirildi" };
  }
}
