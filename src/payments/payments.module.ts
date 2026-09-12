import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { ClickController } from './click/click.controller';
import { ClickService } from './click/click.service';
import { PaymeController } from './payme/payme.controller';
import { PaymeService } from './payme/payme.service';
import { PremiumModule } from '../premium/premium.module';
import { ReferralModule } from '../referral/referral.module';

@Module({
  imports: [PremiumModule, ReferralModule],
  controllers: [PaymentsController, ClickController, PaymeController],
  providers: [PaymentsService, ClickService, PaymeService],
})
export class PaymentsModule {}
