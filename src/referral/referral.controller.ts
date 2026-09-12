import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ReferralService } from './referral.service';
import { WithdrawDto } from './dto/withdraw.dto';

@Controller('referral')
@UseGuards(JwtAuthGuard) // shu controller'dagi barcha endpointlar login talab qiladi
export class ReferralController {
  constructor(private referralService: ReferralService) {}

  // GET /referral/me - o'z referral kodi, hamyon balansi, taklif tarixi
  @Get('me')
  getMyStats(@Req() req: any) {
    return this.referralService.getMyReferralStats(req.user.userId);
  }

  // POST /referral/withdraw  { "amount": 50000 }
  @Post('withdraw')
  requestWithdrawal(@Req() req: any, @Body() dto: WithdrawDto) {
    return this.referralService.requestWithdrawal(req.user.userId, dto.amount);
  }

  // GET /referral/withdrawals - o'z yechib olish so'rovlari tarixi
  @Get('withdrawals')
  getMyWithdrawals(@Req() req: any) {
    return this.referralService.getMyWithdrawals(req.user.userId);
  }
}
