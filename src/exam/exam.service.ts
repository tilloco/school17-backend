import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { PremiumService } from '../premium/premium.service';

const CLOSED_COUNT = 35;
const OPEN_COUNT = 10;
const EXAM_DURATION_MINUTES = 90;

const GEMINI_MODEL = 'gemini-2.5-flash';

// Milliy sertifikat ball tizimi (rasmiy spetsifikatsiyaga mos)
const CLOSED_POINTS: Record<number, number> = { 1: 1.3, 2: 2.2 };
const OPEN_POINTS = { bothCorrect: 3.2, oneCorrect: 1.5, otherOneCorrect: 1.7, none: 0 };

@Injectable()
export class ExamService {
  private readonly logger = new Logger(ExamService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private premium: PremiumService,
  ) {}

  // Mock imtihon - faqat Premium foydalanuvchilar uchun (AI grading xarajati bor)
  private async assertPremium(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!this.premium.isActive(user)) {
      throw new ForbiddenException({
        code: 'PREMIUM_REQUIRED',
        message: 'Sinov imtihoni faqat Premium foydalanuvchilar uchun mavjud',
      });
    }
  }

  async start(userId: string) {


    const existing = await this.prisma.examSession.findFirst({
      where: { userId, status: 'IN_PROGRESS' },
      orderBy: { startedAt: 'desc' },
    });

    if (existing && existing.expiresAt > new Date()) {
      return this.buildSessionPayload(existing.id);
    }

    if (existing) {
      await this.finalizeExpired(existing.id);
    }

    const closedQuestions = await this.pickRandom('CLOSED', CLOSED_COUNT);
    const openQuestions = await this.pickRandom('OPEN', OPEN_COUNT);

    if (closedQuestions.length < CLOSED_COUNT || openQuestions.length < OPEN_COUNT) {
      throw new BadRequestException("Savollar bazasida yetarli savol yo'q - admin bilan bog'laning");
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + EXAM_DURATION_MINUTES * 60 * 1000);

    const session = await this.prisma.examSession.create({
      data: {
        userId,
        status: 'IN_PROGRESS',
        startedAt: now,
        expiresAt,
        answers: {
          create: [...closedQuestions, ...openQuestions].map((q) => ({ questionId: q.id })),
        },
      },
    });

    return this.buildSessionPayload(session.id);
  }

 private async pickRandom(type: 'CLOSED' | 'OPEN', count: number) {
  const all = await this.prisma.question.findMany({
    where: { questionType: type },
    select: { id: true },
  });
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, count);
}

  private async buildSessionPayload(sessionId: string) {
    const session = await this.prisma.examSession.findUniqueOrThrow({
      where: { id: sessionId },
      include: {
        answers: {
          include: { question: true },
        },
      },
    });

    const questions = session.answers.map((a) => ({
      answerId: a.id,
      questionId: a.question.id,
      questionType: a.question.questionType,
      text: a.question.text,
      options: a.question.questionType === 'CLOSED' ? a.question.options : undefined,
      partAPrompt: a.question.questionType === 'OPEN' ? a.question.partAPrompt : undefined,
      partBPrompt: a.question.questionType === 'OPEN' ? a.question.partBPrompt : undefined,
      savedChosenIndex: a.chosenIndex,
      savedPartAText: a.partAText,
      savedPartBText: a.partBText,
    }));

    return {
      sessionId: session.id,
      status: session.status,
      startedAt: session.startedAt,
      expiresAt: session.expiresAt,
      totalQuestions: questions.length,
      questions,
    };
  }

  async saveAnswer(
    userId: string,
    sessionId: string,
    answerId: string,
    data: { chosenIndex?: number; partAText?: string; partBText?: string },
  ) {
    const session = await this.getOwnedInProgressSession(userId, sessionId);

    const answer = session.answers.find((a) => a.id === answerId);
    if (!answer) throw new NotFoundException('Javob topilmadi');

    await this.prisma.examAnswer.update({
      where: { id: answerId },
      data: {
        chosenIndex: data.chosenIndex ?? undefined,
        partAText: data.partAText?.slice(0, 2000) ?? undefined,
        partBText: data.partBText?.slice(0, 2000) ?? undefined,
      },
    });

    return { saved: true };
  }

  async submit(userId: string, sessionId: string) {
    const session = await this.getOwnedInProgressSession(userId, sessionId);
    return this.grade(session.id);
  }

  private async getOwnedInProgressSession(userId: string, sessionId: string) {
    const session = await this.prisma.examSession.findUnique({
      where: { id: sessionId },
      include: { answers: { include: { question: true } } },
    });
    if (!session || session.userId !== userId) throw new NotFoundException('Sinov imtihoni topilmadi');
    if (session.status !== 'IN_PROGRESS') throw new BadRequestException('Bu sinov imtihoni allaqachon yakunlangan');
    return session;
  }

  private async finalizeExpired(sessionId: string) {
    await this.grade(sessionId, 'EXPIRED');
  }

  private calculateGrade(totalScore: number): string | null {
    if (totalScore >= 70) return "A+";
    if (totalScore >= 65) return "A";
    if (totalScore >= 60) return "B+";
    if (totalScore >= 55) return "B";
    if (totalScore >= 50) return "C+";
    if (totalScore >= 46) return "C";
    return null;
  }

  private async grade(sessionId: string, finalStatus: 'COMPLETED' | 'EXPIRED' = 'COMPLETED') {
    const session = await this.prisma.examSession.findUniqueOrThrow({
      where: { id: sessionId },
      include: { answers: { include: { question: true } } },
    });

    let totalScore = 0;
    let maxScore = 0;

    for (const answer of session.answers) {
      const q = answer.question;

      if (q.questionType === 'CLOSED') {
        const maxPoints = CLOSED_POINTS[q.difficulty] ?? CLOSED_POINTS[1];
        maxScore += maxPoints;

        const isCorrect = answer.chosenIndex !== null && answer.chosenIndex === q.correctIndex;
        const points = isCorrect ? maxPoints : 0;
        totalScore += points;

        await this.prisma.examAnswer.update({
          where: { id: answer.id },
          data: { isCorrect, pointsEarned: points },
        });
      } else {
        maxScore += OPEN_POINTS.bothCorrect;

        const { partACorrect, partBCorrect } = await this.gradeOpenAnswer(
          q.partAPrompt ?? '',
          q.partAAnswer ?? '',
          answer.partAText ?? '',
          q.partBPrompt ?? '',
          q.partBAnswer ?? '',
          answer.partBText ?? '',
        );

        let points = OPEN_POINTS.none;
        if (partACorrect && partBCorrect) points = OPEN_POINTS.bothCorrect;
        else if (partACorrect) points = OPEN_POINTS.oneCorrect;
        else if (partBCorrect) points = OPEN_POINTS.otherOneCorrect;

        totalScore += points;

        await this.prisma.examAnswer.update({
          where: { id: answer.id },
          data: { partACorrect, partBCorrect, pointsEarned: points },
        });
      }
    }

    const percentage = maxScore > 0 ? (totalScore / maxScore) * 100 : 0;
    const grade = this.calculateGrade(totalScore);

    await this.prisma.examSession.update({
      where: { id: sessionId },
      data: {
        status: finalStatus,
        submittedAt: new Date(),
        totalScore,
        maxScore,
        percentage,
        grade,
      },
    });

    return this.getResult(sessionId);
  }

  private async gradeOpenAnswer(
    partAPrompt: string,
    partAModelAnswer: string,
    partAUserAnswer: string,
    partBPrompt: string,
    partBModelAnswer: string,
    partBUserAnswer: string,
  ): Promise<{ partACorrect: boolean; partBCorrect: boolean }> {
    const apiKeys = [
      this.config.get<string>('GEMINI_API_KEY'),
      this.config.get<string>('GEMINI_API_KEY_2'),
    ].filter((k): k is string => !!k);

    if (apiKeys.length === 0) {
      this.logger.warn('GEMINI_API_KEY sozlanmagan - ochiq savol baholanmadi (0 ball)');
      return { partACorrect: false, partBCorrect: false };
    }

    const systemPrompt = [
      "Siz huquq imtihoni javoblarini baholovchi yordamchisiz.",
      "Sizga har bir qism uchun: savol, namunaviy (to'g'ri) javob, va talabaning yozgan javobi beriladi.",
      "Talabaning javobi so'zma-so'z bir xil bo'lishi shart emas - agar mazmunan to'g'ri va asosiy huquqiy mohiyatni to'g'ri aks ettirsa, to'g'ri deb hisoblang.",
      "Bo'sh yoki mavzuga aloqasi yo'q javoblarni har doim noto'g'ri deb baholang.",
      'Javobni FAQAT quyidagi JSON formatida qaytaring, boshqa hech narsa qo\'shmang:',
      '{"partACorrect": boolean, "partBCorrect": boolean}',
    ].join('\n');

    const userContent = JSON.stringify({
      partA: { prompt: partAPrompt, modelAnswer: partAModelAnswer, studentAnswer: partAUserAnswer },
      partB: { prompt: partBPrompt, modelAnswer: partBModelAnswer, studentAnswer: partBUserAnswer },
    });

    for (let i = 0; i < apiKeys.length; i++) {
      const apiKey = apiKeys[i];
      try {
        const res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
          {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userContent }] }],
            generationConfig: { responseMimeType: 'application/json' },
          },
          { headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' }, timeout: 20_000 },
        );

        const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        const parsed = JSON.parse(text);
        return {
          partACorrect: parsed.partACorrect === true,
          partBCorrect: parsed.partBCorrect === true,
        };
      } catch (err) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        this.logger.warn(`Gemini key #${i + 1} bilan xatolik (status: ${status ?? 'unknown'}) - keyingi kalitga o'tilmoqda`);
        if (i === apiKeys.length - 1) {
          this.logger.error(`Barcha Gemini kalitlar ishlamadi: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    return { partACorrect: false, partBCorrect: false };
  }

  async getResult(sessionId: string) {
    const session = await this.prisma.examSession.findUniqueOrThrow({
      where: { id: sessionId },
      include: { answers: { include: { question: true } } },
    });

    const closedAnswers = session.answers.filter((a) => a.question.questionType === 'CLOSED');
    const openAnswers = session.answers.filter((a) => a.question.questionType === 'OPEN');

    return {
      sessionId: session.id,
      status: session.status,
      totalScore: session.totalScore,
      maxScore: session.maxScore,
      percentage: session.percentage,
      grade: session.grade,
      closedCorrect: closedAnswers.filter((a) => a.isCorrect).length,
      closedTotal: closedAnswers.length,
      openFullyCorrect: openAnswers.filter((a) => a.partACorrect && a.partBCorrect).length,
      openTotal: openAnswers.length,
      review: session.answers.map((a) => ({
        questionText: a.question.text,
        questionType: a.question.questionType,
        chosenIndex: a.chosenIndex,
        correctIndex: a.question.questionType === 'CLOSED' ? a.question.correctIndex : undefined,
        explanation: a.question.questionType === 'CLOSED' ? a.question.explanation : undefined,
        partAText: a.partAText,
        partACorrect: a.partACorrect,
        partBText: a.partBText,
        partBCorrect: a.partBCorrect,
        pointsEarned: a.pointsEarned,
      })),
    };
  }

  async getHistory(userId: string) {
    return this.prisma.examSession.findMany({
      where: { userId, status: { in: ['COMPLETED', 'EXPIRED'] } },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        startedAt: true,
        submittedAt: true,
        totalScore: true,
        maxScore: true,
        percentage: true,
        grade: true,
        status: true,
      },
    });
  }
}