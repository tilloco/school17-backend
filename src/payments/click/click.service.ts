import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { PremiumService, PremiumGrantSource } from '../../premium/premium.service';
import { ReferralService } from '../../referral/referral.service';
import { ClickWebhookDto } from './dto/click-webhook.dto';
import { ClickError } from './click-error';

@Injectable()
export class ClickService {
  private readonly logger = new Logger(ClickService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private premium: PremiumService,
    private referral: ReferralService,
  ) {}

  // Click bitta URL'ga ham Prepare (action=0), ham Complete (action=1) so'rovlarini
  // yuboradi - shu yerda ikkalasiga ham yo'naltiramiz.
  async handleWebhook(dto: ClickWebhookDto) {
    if (!this.verifySign(dto)) {
      this.logger.warn(`Click: imzo mos kelmadi - merchant_trans_id=${dto.merchant_trans_id}`);
      return this.errorResponse(dto, ClickError.SIGN_CHECK_FAILED, 'SIGN CHECK FAILED');
    }

    if (dto.action === '0') return this.handlePrepare(dto);
    if (dto.action === '1') return this.handleComplete(dto);

    return this.errorResponse(dto, ClickError.ACTION_NOT_FOUND, 'Action not found');
  }

  private async handlePrepare(dto: ClickWebhookDto) {
    const payment = await this.prisma.payment.findUnique({ where: { id: dto.merchant_trans_id } });
    if (!payment) {
      return this.errorResponse(dto, ClickError.USER_NOT_FOUND, 'Order not found');
    }
    if (!this.amountMatches(payment.amount, dto.amount)) {
      return this.errorResponse(dto, ClickError.INVALID_AMOUNT, 'Incorrect amount');
    }
    if (payment.status === 'SUCCESS') {
      return this.errorResponse(dto, ClickError.ALREADY_PAID, 'Already paid');
    }

    // Idempotentlik: Click prepare so'rovini qayta yuborishi mumkin (masalan tarmoq
    // xatosi tufayli javobni olmagan bo'lsa) - bir xil click_trans_id uchun eski yozuvni
    // qaytaramiz, yangisini yaratmaymiz.
    let tx = await this.prisma.clickTransaction.findUnique({ where: { clickTransId: dto.click_trans_id } });
    if (!tx) {
      tx = await this.prisma.clickTransaction.create({
        data: {
          paymentId: payment.id,
          clickTransId: dto.click_trans_id,
          clickPaydocId: dto.click_paydoc_id,
          state: 'CREATED',
        },
      });
    }

    return {
      click_trans_id: dto.click_trans_id,
      merchant_trans_id: dto.merchant_trans_id,
      merchant_prepare_id: tx.id,
      error: ClickError.SUCCESS,
      error_note: 'Success',
    };
  }

  private async handleComplete(dto: ClickWebhookDto) {
    const payment = await this.prisma.payment.findUnique({ where: { id: dto.merchant_trans_id } });
    if (!payment) {
      return this.errorResponse(dto, ClickError.USER_NOT_FOUND, 'Order not found');
    }

    const prepareId = Number(dto.merchant_prepare_id);
    const tx = await this.prisma.clickTransaction.findUnique({ where: { id: prepareId } });
    if (!tx || tx.clickTransId !== dto.click_trans_id) {
      return this.errorResponse(dto, ClickError.TRANSACTION_NOT_FOUND, 'Transaction not found');
    }
    if (tx.state === 'CANCELLED') {
      return this.errorResponse(dto, ClickError.TRANSACTION_CANCELLED, 'Transaction cancelled');
    }
    if (!this.amountMatches(payment.amount, dto.amount)) {
      return this.errorResponse(dto, ClickError.INVALID_AMOUNT, 'Incorrect amount');
    }

    // Click to'lov muvaffaqiyatsiz bo'lganini bildirsa (error != 0) - biz ham bekor qilamiz
    if (Number(dto.error) < 0) {
      await this.prisma.$transaction([
        this.prisma.clickTransaction.update({
          where: { id: tx.id },
          data: { state: 'CANCELLED', cancelledAt: new Date() },
        }),
        this.prisma.payment.update({ where: { id: payment.id }, data: { status: 'FAILED' } }),
      ]);
      return { click_trans_id: dto.click_trans_id, merchant_trans_id: dto.merchant_trans_id, error: ClickError.SUCCESS, error_note: 'Success' };
    }

    // XAVFSIZLIK/IDEMPOTENTLIK: Complete ham qayta yuborilishi mumkin. state='CREATED'
    // shartli atomik update orqali - premium/referral mukofoti FAQAT bitta marta beriladi,
    // hatto Click bir xil so'rovni bir necha marta yuborsa ham.
    const claimed = await this.prisma.clickTransaction.updateMany({
      where: { id: tx.id, state: 'CREATED' },
      data: { state: 'CONFIRMED', confirmedAt: new Date() },
    });

    if (claimed.count > 0) {
      await this.prisma.payment.update({ where: { id: payment.id }, data: { status: 'SUCCESS' } });
      await this.premium.extendPremium(payment.userId, payment.months, PremiumGrantSource.PAYMENT);
      await this.referral.rewardOnPremiumPurchase(payment.userId);
      this.logger.log(`Click to'lovi tasdiqlandi: payment=${payment.id} user=${payment.userId}`);
    }

    return {
      click_trans_id: dto.click_trans_id,
      merchant_trans_id: dto.merchant_trans_id,
      merchant_confirm_id: tx.id,
      error: ClickError.SUCCESS,
      error_note: 'Success',
    };
  }

  // sign_string = md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id + [merchant_prepare_id +] amount + action + sign_time)
  // ([merchant_prepare_id] faqat Complete/action=1 uchun qo'shiladi)
  //
  // DIQQAT: bu formula Click'ning rasman e'lon qilingan (Prepare uchun docs.click.uz'da
  // tasdiqlangan) va ko'plab ochiq kutubxonalarda ishlatilgan Complete formulasi asosida
  // yozilgan. Ishga tushirishdan oldin Click test muhitida (sandbox) albatta tekshiring -
  // agar mos kelmasa, Click hamkor menejeringiz aniq formula va test misolini beradi.
  private verifySign(dto: ClickWebhookDto): boolean {
    const secret = this.config.get<string>('CLICK_SECRET_KEY') || '';
    if (!secret) {
      this.logger.error('CLICK_SECRET_KEY .env da sozlanmagan');
      return false;
    }

    const parts =
      dto.action === '1'
        ? [dto.click_trans_id, dto.service_id, secret, dto.merchant_trans_id, dto.merchant_prepare_id ?? '', dto.amount, dto.action, dto.sign_time]
        : [dto.click_trans_id, dto.service_id, secret, dto.merchant_trans_id, dto.amount, dto.action, dto.sign_time];

    const expected = createHash('md5').update(parts.join('')).digest('hex');

    const a = Buffer.from(expected);
    const b = Buffer.from(dto.sign_string || '');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // Click amount'ni float sifatida yuboradi ("50000.00") - bizda Int (so'm) saqlanadi,
  // shuning uchun yaxlitlashdan kelib chiqadigan farqlarga ozgina tolerantlik beramiz.
  private amountMatches(paymentAmount: number, clickAmount: string): boolean {
    const parsed = parseFloat(clickAmount);
    return Math.abs(parsed - paymentAmount) < 1;
  }

  private errorResponse(dto: ClickWebhookDto, error: number, note: string) {
    return {
      click_trans_id: dto.click_trans_id,
      merchant_trans_id: dto.merchant_trans_id,
      error,
      error_note: note,
    };
  }
}
