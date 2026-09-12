import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OnboardingService } from './onboarding.service';
import { AnswerOnboardingDto } from './dto/answer-onboarding.dto';

@Controller('onboarding')
@UseGuards(JwtAuthGuard)
export class OnboardingController {
  constructor(private onboarding: OnboardingService) {}

  // GET /onboarding/status -> tells the app whether to show onboarding or the dashboard
  @Get('status')
  status(@Req() req: any) {
    return this.onboarding.getStatus(req.user.userId);
  }

  // POST /onboarding/start -> begins (or resumes) the conversation, returns first/next question
  @Post('start')
  start(@Req() req: any) {
    return this.onboarding.start(req.user.userId);
  }

  // POST /onboarding/answer { answer: string } -> submits an answer, returns next question or final plan
  @Post('answer')
  answer(@Req() req: any, @Body() dto: AnswerOnboardingDto) {
    return this.onboarding.answer(req.user.userId, dto.answer);
  }
}