import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../admin-auth/admin-jwt-auth.guard';
import { ReferralService } from './referral.service';
import { ProcessWithdrawalDto } from './dto/process-withdrawal.dto';

// XAVFSIZLIK: bu controller ATAYLAB /referral (ReferralController) dan ALOHIDA -
// avvalgi versiyada admin route'lar class-darajasidagi JwtAuthGuard ostidagi
// ReferralController ichida edi, shuning uchun @UseGuards(AdminJwtAuthGuard) qo'shilsa ham
// IKKALA guard ham talab qilinardi (Nest controller+method guardlarni birlashtiradi,
// almashtirmaydi) - ya'ni chaqiruvchi HAM tizimga kirgan foydalanuvchi, HAM admin
// kalitiga ega bo'lishi kerak edi. Bu haqiqiy admin vositasi (masalan curl/Postman,
// hali login qilmagan admin panel) uchun ishlamay qolardi. Shu sabab admin route'lar
// endi mustaqil, faqat AdminJwtAuthGuard talab qiladigan controller'da.
// 8-BOSQICH: endi haqiqiy Admin login (email+parol) orqali olingan token talab qilinadi.
@Controller('referral/admin')
@UseGuards(AdminJwtAuthGuard)
export class ReferralAdminController {
  constructor(private referralService: ReferralService) {}

  // GET /referral/admin/withdrawals?status=PENDING
  @Get('withdrawals')
  listWithdrawals(@Query('status') status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAID') {
    return this.referralService.listWithdrawals(status);
  }

  // PATCH /referral/admin/withdrawals/:id  { "status": "APPROVED", "note": "Click orqali yuborildi" }
  @Patch('withdrawals/:id')
  processWithdrawal(@Param('id') id: string, @Body() dto: ProcessWithdrawalDto) {
    return this.referralService.processWithdrawal(id, dto.status, dto.note);
  }
}
