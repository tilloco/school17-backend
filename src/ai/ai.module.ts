import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PremiumModule } from '../premium/premium.module';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';

@Module({
  imports: [PrismaModule, PremiumModule],
  controllers: [AiController],
  providers: [AiService],
})
export class AiModule {}
