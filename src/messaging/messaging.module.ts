import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MessagingGateway } from './messaging.gateway';
import { MessagingService } from './messaging.service';
import { MessagingController } from './messaging.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule, JwtModule.register({})], // secret is read per-call via ConfigService, so empty register is fine
  providers: [MessagingGateway, MessagingService],
  controllers: [MessagingController],
})
export class MessagingModule {}