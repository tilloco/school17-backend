import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ExamService } from './exam.service';
import { SaveExamAnswerDto } from './dto/save-exam-answer.dto';

@Controller('exam')
@UseGuards(JwtAuthGuard)
export class ExamController {
  constructor(private exam: ExamService) {}

  // POST /exam/start -> yangi sinov imtihonini boshlaydi (yoki davom etayotganini qaytaradi)
  @Post('start')
  start(@Req() req: any) {
    return this.exam.start(req.user.userId);
  }

  // PATCH-style autosave, lekin oddiylik uchun POST qilib qo'yamiz
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post(':sessionId/answer/:answerId')
  saveAnswer(
    @Req() req: any,
    @Param('sessionId') sessionId: string,
    @Param('answerId') answerId: string,
    @Body() dto: SaveExamAnswerDto,
  ) {
    return this.exam.saveAnswer(req.user.userId, sessionId, answerId, dto);
  }

  @Post(':sessionId/submit')
  submit(@Req() req: any, @Param('sessionId') sessionId: string) {
    return this.exam.submit(req.user.userId, sessionId);
  }

  @Get(':sessionId/result')
  getResult(@Param('sessionId') sessionId: string) {
    return this.exam.getResult(sessionId);
  }

  @Get('history')
  getHistory(@Req() req: any) {
    return this.exam.getHistory(req.user.userId);
  }
}