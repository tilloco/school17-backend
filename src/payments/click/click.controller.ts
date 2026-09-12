import { Body, Controller, Post } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ClickService } from './click.service';
import { ClickWebhookDto } from './dto/click-webhook.dto';

// XAVFSIZLIK ESLATMASI: bu endpoint global JwtAuthGuard'dan tashqarida (Click bizga
// token yubormaydi) - o'rniga har bir so'rov ClickService.verifySign() orqali
// sign_string bo'yicha tasdiqlanadi. Shuning uchun controller darajasida hech qanday
// @UseGuards(JwtAuthGuard) QO'YILMASLIGI kerak, lekin service ichidagi imzo tekshiruvi
// ham HECH QACHON olib tashlanmasligi kerak.
//
// @SkipThrottle(): Click o'zining serverlaridan (bitta yoki bir nechta IP'dan) qisqa
// vaqt ichida ko'p Prepare/Complete so'rovi yuborishi mumkin (real foydalanuvchilar
// ko'p bo'lganda). Global IP-cheklov bunga tegib, HAQIQIY to'lovlarni to'sib qo'yishi
// mumkin edi - buning o'rniga bu yerda yagona himoya sign_string tekshiruvi (yuqorida
// aytilganidek, har doim ishlab turishi SHART).
@SkipThrottle()
@Controller('payments/click')
export class ClickController {
  constructor(private clickService: ClickService) {}

  // POST /payments/click/webhook
  // Click bitta shu manzilga ham Prepare (action=0), ham Complete (action=1) so'rovlarini
  // yuboradi. Bu URL'ni Click hamkor kabinetida "Callback URL" sifatida ko'rsating.
  @Post('webhook')
  webhook(@Body() dto: ClickWebhookDto) {
    return this.clickService.handleWebhook(dto);
  }
}
