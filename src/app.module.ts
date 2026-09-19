import { Module } from '@nestjs/common';
import { OnboardingModule } from './onboarding/onboarding.module';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ContentModule } from './content/content.module';
import { QuizModule } from './quiz/quiz.module';
import { PremiumModule } from './premium/premium.module';
import { ReferralModule } from './referral/referral.module';
import { PaymentsModule } from './payments/payments.module';
import { AiModule } from './ai/ai.module';
import { AdminAuthModule } from './admin-auth/admin-auth.module';
import { AdminModule } from './admin/admin.module';
import { ExamModule } from './exam/exam.module';

@Module({
  imports: [

    ConfigModule.forRoot({ isGlobal: true }), // .env faylni butun ilova bo'ylab o'qiydi
    // Global IP-asosli so'rov cheklovi (butun API uchun umumiy himoya qatlami).
    // OTP endpointlari bundan tashqari o'zining qattiqroq (@Throttle) limitiga ega.
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000, // 1 daqiqa
        limit: 60, // IP boshiga daqiqasiga 60 so'rov
      },
    ]),
    PrismaModule,
    AuthModule,
    UsersModule,
    ContentModule,
    QuizModule,
    PremiumModule,
    ReferralModule,
    PaymentsModule,
    AiModule,
    AdminAuthModule,
    AdminModule,
    OnboardingModule,
    ExamModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
