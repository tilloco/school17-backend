import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PremiumModule } from '../premium/premium.module';
import { ExamController } from './exam.controller';
import { ExamService } from './exam.service';

@Module({
  imports: [PrismaModule, PremiumModule],
  controllers: [ExamController],
  providers: [ExamService],
})
export class ExamModule {}