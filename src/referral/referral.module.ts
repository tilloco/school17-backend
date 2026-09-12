import { Module } from '@nestjs/common';
import { ReferralService } from './referral.service';
import { ReferralController } from './referral.controller';
import { ReferralAdminController } from './referral-admin.controller';
import { PremiumModule } from '../premium/premium.module';

@Module({
  imports: [PremiumModule],
  providers: [ReferralService],
  controllers: [ReferralController, ReferralAdminController],
  exports: [ReferralService], // AuthModule (ro'yxatdan o'tishda) va Payment (5-bosqich) ishlatadi
})
export class ReferralModule {}
