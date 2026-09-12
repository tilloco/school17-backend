import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PaymentsService } from './payments.service';
import { InitPaymentDto } from './dto/init-payment.dto';

@Controller('payments')
@UseGuards(JwtAuthGuard)
export class PaymentsController {
  constructor(private paymentsService: PaymentsService) {}

  // POST /payments/init  { "provider": "CLICK", "months": 1 }
  // Javobda qaytgan payUrl'ni mobil ilova WebView/browser orqali ochadi.
  @Post('init')
  init(@Req() req: any, @Body() dto: InitPaymentDto) {
    return this.paymentsService.initPayment(req.user.userId, dto.provider, dto.months);
  }
}
