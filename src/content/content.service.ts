import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateModuleDto, CreateWeekDto, CreateLessonDto, CreateQuestionDto, BulkCreateQuestionsDto } from './dto/content.dto';

@Injectable()
export class ContentService {
  constructor(private prisma: PrismaService) {}

  // --- O'QISH (mobil ilova uchun, ochiq) ---

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

  async getLesson(lessonId: string) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: {
        questions: {
          select: { id: true, text: true, options: true },
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

  // --- Ommaviy savol qo'shish (bulk text -> ko'p savol, CLOSED va OPEN) ---

  async createQuestionsBulk(dto: BulkCreateQuestionsDto) {
    const lesson = await this.prisma.lesson.findUnique({ where: { id: dto.lessonId } });
    if (!lesson) throw new NotFoundException('Dars topilmadi');

    const parsed = this.parseBulkText(dto.text);

    await this.prisma.question.createMany({
      data: parsed.map((q) => {
        if (q.questionType === 'OPEN') {
          return {
            lessonId: dto.lessonId,
            text: q.text,
            questionType: 'OPEN' as const,
            options: [],
            correctIndex: 0,
            explanation: '',
            partAPrompt: q.partAPrompt,
            partAAnswer: q.partAAnswer,
            partBPrompt: q.partBPrompt,
            partBAnswer: q.partBAnswer,
          };
        }
        return {
          lessonId: dto.lessonId,
          text: q.text,
          questionType: 'CLOSED' as const,
          options: q.options,
          correctIndex: q.correctIndex,
          explanation: q.explanation,
          difficulty: q.difficulty,
           concept: q.concept,
        };
      }),
    });

    return { message: `${parsed.length} ta savol qo'shildi`, count: parsed.length };
  }

  // Bloklarni ajratadi ('---' bilan). TYPE: OPEN bo'lsa ochiq savol
  // (PART_A/ANSWER_A/PART_B/ANSWER_B), aks holda yopiq savol (Q:/A)../CORRECT:/EXPLAIN:).
  private parseBulkText(raw: string) {
    const blocks = raw
      .split(/\n\s*-{3,}\s*\n/)
      .map((b) => b.trim())
      .filter((b) => b.length > 0);

    if (blocks.length === 0) {
      throw new BadRequestException("Matnda birorta ham savol topilmadi (bloklar '---' bilan ajratiladi)");
    }

    return blocks.map((block, idx) => {
      const lines = block
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      const label = `${idx + 1}-blok`;
      const isOpen = lines.some((l) => /^TYPE:\s*OPEN\s*$/i.test(l));

      if (isOpen) {
        let questionText = '';
        let partAPrompt = '';
        let partAAnswer = '';
        let partBPrompt = '';
        let partBAnswer = '';

        for (const line of lines) {
          const qMatch = line.match(/^Q:\s*(.+)$/i);
          const paMatch = line.match(/^PART_A:\s*(.+)$/i);
          const aaMatch = line.match(/^ANSWER_A:\s*(.+)$/i);
          const pbMatch = line.match(/^PART_B:\s*(.+)$/i);
          const abMatch = line.match(/^ANSWER_B:\s*(.+)$/i);

          if (qMatch) questionText = qMatch[1].trim();
          else if (paMatch) partAPrompt = paMatch[1].trim();
          else if (aaMatch) partAAnswer = aaMatch[1].trim();
          else if (pbMatch) partBPrompt = pbMatch[1].trim();
          else if (abMatch) partBAnswer = abMatch[1].trim();
        }

        if (!questionText) throw new BadRequestException(`${label}: "Q:" qatori topilmadi`);
        if (!partAPrompt) throw new BadRequestException(`${label}: "PART_A:" qatori topilmadi`);
        if (!partAAnswer) throw new BadRequestException(`${label}: "ANSWER_A:" qatori topilmadi`);
        if (!partBPrompt) throw new BadRequestException(`${label}: "PART_B:" qatori topilmadi`);
        if (!partBAnswer) throw new BadRequestException(`${label}: "ANSWER_B:" qatori topilmadi`);

        return {
          questionType: 'OPEN' as const,
          text: questionText,
          partAPrompt,
          partAAnswer,
          partBPrompt,
          partBAnswer,
        };
      }

          let questionText = '';
      const options: string[] = [];
      let correctLetter = '';
      let explanation = '';
      let difficulty = 1;
      let concept = '';

      for (const line of lines) {
        const qMatch = line.match(/^Q:\s*(.+)$/i);
        const optMatch = line.match(/^([A-D])\)\s*(.+)$/i);
        const correctMatch = line.match(/^CORRECT:\s*([A-D])\s*$/i);
        const explainMatch = line.match(/^EXPLAIN:\s*(.+)$/i);
        const difficultyMatch = line.match(/^DIFFICULTY:\s*([12])\s*$/i);
        const conceptMatch = line.match(/^CONCEPT:\s*(.+)$/i);

        if (qMatch) questionText = qMatch[1].trim();
        else if (optMatch) options.push(optMatch[2].trim());
        else if (correctMatch) correctLetter = correctMatch[1].toUpperCase();
        else if (explainMatch) explanation = explainMatch[1].trim();
        else if (difficultyMatch) difficulty = parseInt(difficultyMatch[1], 10);
        else if (conceptMatch) concept = conceptMatch[1].trim();
      }

      if (!questionText) throw new BadRequestException(`${label}: "Q:" qatori topilmadi`);
      if (options.length < 2 || options.length > 4)
        throw new BadRequestException(`${label} ("${questionText.slice(0, 30)}"): 2-4 ta variant kerak, ${options.length} ta topildi`);
      if (!correctLetter) throw new BadRequestException(`${label}: "CORRECT:" qatori topilmadi`);

      const correctIndex = correctLetter.charCodeAt(0) - 'A'.charCodeAt(0);
      if (correctIndex >= options.length)
        throw new BadRequestException(`${label}: CORRECT harfi (${correctLetter}) variantlar sonidan tashqarida`);
      if (!explanation) throw new BadRequestException(`${label}: "EXPLAIN:" qatori topilmadi`);

      return {
        questionType: 'CLOSED' as const,
        text: questionText,
        options,
        correctIndex,
        explanation,
        difficulty,
        concept:concept || null,
      };
    });
  }
}