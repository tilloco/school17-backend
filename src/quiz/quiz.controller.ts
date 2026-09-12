import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { QuizService } from './quiz.service';
import { SubmitAnswerDto } from './dto/submit-answer.dto';

@Controller('quiz')
@UseGuards(JwtAuthGuard) // test yechish uchun tizimga kirgan bo'lish shart
export class QuizController {
  constructor(private quizService: QuizService) {}

  // POST /quiz/answer  { "questionId": "...", "chosenIndex": 1 }
  @Post('answer')
  submitAnswer(@Req() req: any, @Body() dto: SubmitAnswerDto) {
    return this.quizService.submitAnswer(req.user.userId, dto.questionId, dto.chosenIndex);
  }

  // POST /quiz/lessons/:id/complete
  @Post('lessons/:id/complete')
  completeLesson(@Req() req: any, @Param('id') lessonId: string) {
    return this.quizService.completeLesson(req.user.userId, lessonId);
  }

  // GET /quiz/free-quota  -> { isPremium, remainingToday }
  @Get('free-quota')
  getFreeQuota(@Req() req: any) {
    return this.quizService.getFreeQuota(req.user.userId);
  }
}
