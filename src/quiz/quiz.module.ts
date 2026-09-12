import { Module } from '@nestjs/common';
import { QuizController } from './quiz.controller';
import { QuizService } from './quiz.service';
import { PremiumModule } from '../premium/premium.module';

@Module({
  imports: [PremiumModule],
  controllers: [QuizController],
  providers: [QuizService],
})
export class QuizModule {}
