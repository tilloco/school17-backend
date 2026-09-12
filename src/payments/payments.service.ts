import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { getPriceForMonths } from './pricing';

@Injectable()
export class PaymentsService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  // Foydalanuvchi "Premium sotib olish" tugmasini bosganda chaqiriladi. Narx bu yerda
  // (serverda) PREMIUM_PRICING'dan olinadi - mobil ilova faqat "months" yuboradi, "amount"
  // emas, shuning uchun narxni o'zgartirib yuborish mumkin emas.
  async initPayment(userId: string, provider: 'CLICK' | 'PAYME', months: number) {
    const amount = getPriceForMonths(months);

    const payment = await this.prisma.payment.create({
      data: { userId, amount, months, provider: provider as any, status: 'PENDING' },
    });

    if (provider === 'CLICK') {
      return { paymentId: payment.id, payUrl: this.buildClickUrl(payment.id, amount) };
    }
    return { paymentId: payment.id, payUrl: this.buildPaymeUrl(payment.id, amount) };
  }

  private buildClickUrl(paymentId: string, amountSom: number): string {
    const serviceId = this.config.get<string>('CLICK_SERVICE_ID');
    const merchantId = this.config.get<string>('CLICK_MERCHANT_ID');
    const returnUrl = this.config.get<string>('CLICK_RETURN_URL') || 'https://example.com';

    const params = new URLSearchParams({
      service_id: serviceId || '',
      merchant_id: merchantId || '',
      amount: amountSom.toFixed(2),
      transaction_param: paymentId, // = merchant_trans_id, webhook shu orqali Payment'ni topadi
      return_url: returnUrl,
    });
    return `https://my.click.uz/services/pay?${params.toString()}`;
  }

  private buildPaymeUrl(paymentId: string, amountSom: number): string {
    const merchantId = this.config.get<string>('PAYME_MERCHANT_ID') || '';
    const amountTiyin = Math.round(amountSom * 100); // Payme har doim tiyinda ishlaydi
    const returnUrl = this.config.get<string>('PAYME_RETURN_URL') || 'https://example.com';

    // Payme checkout URL'i base64'ga o'ralgan "key=value;key=value" parametrlaridan iborat.
    // "ac.order_id" - bizning hisob raqamimiz maydoni (Payme'dagi "account.order_id" bilan mos
    // kelishi kerak - shu bo'yicha PaymeService.checkPerformTransaction qidiradi).
    const raw = `m=${merchantId};ac.order_id=${paymentId};a=${amountTiyin};c=${encodeURIComponent(returnUrl)}`;
    const encoded = Buffer.from(raw).toString('base64');
    return `https://checkout.paycom.uz/${encoded}`;
  }
}
