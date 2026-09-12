import { Module } from '@nestjs/common';
import { PremiumService } from './premium.service';

@Module({
  providers: [PremiumService],
  exports: [PremiumService], // Referral, Payment (5-bosqich) va Admin modullari ishlatadi
})
export class PremiumModule {}
