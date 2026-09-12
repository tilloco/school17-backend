import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AiService } from './ai.service';

@Controller('ai')
@UseGuards(JwtAuthGuard) // AI tavsiyalar faqat tizimga kirgan (va servis ichida premium) foydalanuvchilar uchun
export class AiController {
  constructor(private aiService: AiService) {}

  // GET /ai/recommendation           -> keshdagi (yoki yangi generatsiya qilingan) tavsiyani qaytaradi
  // GET /ai/recommendation?refresh=true -> majburiy qayta generatsiya qilishga urinadi (1 soatlik limit bilan)
  // Qo'shimcha himoya qatlami: global ThrottlerGuard'dan tashqari, bu route uchun
  // qattiqroq limit - AI chaqiruvi pullik bo'lgani uchun spam so'rovlardan himoya.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('recommendation')
  getRecommendation(@Req() req: any, @Query('refresh') refresh?: string) {
    return this.aiService.getRecommendation(req.user.userId, refresh === 'true');
  }
}
