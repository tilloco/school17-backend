import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PremiumService, PremiumGrantSource } from '../../premium/premium.service';
import { ReferralService } from '../../referral/referral.service';
import { PaymeErrorCode, PaymeRpcError } from './payme-error';

// Payme "yaratilgandan 12 soat o'tsa, avtomatik bekor qilinadi" qoidasi (rasmiy hujjat)
const TRANSACTION_TIMEOUT_MS = 12 * 60 * 60 * 1000;

@Injectable()
export class PaymeService {
  private readonly logger = new Logger(PaymeService.name);

  constructor(
    private prisma: PrismaService,
    private premium: PremiumService,
    private referral: ReferralService,
  ) {}

  async checkPerformTransaction(params: any) {
    const payment = await this.findPaymentByAccount(params?.account);
    this.assertAmountMatches(payment.amount, params?.amount);

    return { allow: true };
  }

  // Payme'ning o'zi ta'kidlaganidek: agar tranzaksiya allaqachon yaratilgan bo'lsa, shu
  // yozuvni asosiy tekshiruv bilan qaytarish kifoya (yangisini yaratmang) - shuning
  // uchun avval paymeId bo'yicha mavjudligini tekshiramiz (idempotentlik).
  async createTransaction(params: any) {
    const paymeId: string = params?.id;
    const existing = await this.prisma.paymeTransaction.findUnique({ where: { paymeId } });
    if (existing) {
      return {
        create_time: existing.createTime.getTime(),
        transaction: existing.id,
        state: this.stateToNumber(existing.state),
      };
    }

    const payment = await this.findPaymentByAccount(params?.account);
    this.assertAmountMatches(payment.amount, params?.amount);

    if (payment.status === 'SUCCESS') {
      throw new PaymeRpcError(PaymeErrorCode.CANNOT_PERFORM_OPERATION, "Buyurtma allaqachon to'langan");
    }

    const created = await this.prisma.paymeTransaction.create({
      data: {
        paymeId,
        paymentId: payment.id,
        amount: params.amount,
        state: 'CREATED',
      },
    });

    return {
      create_time: created.createTime.getTime(),
      transaction: created.id,
      state: 1,
    };
  }

  async performTransaction(params: any) {
    const tx = await this.getTxOrThrow(params?.id);

    if (tx.state === 'COMPLETED') {
      // Idempotent: allaqachon bajarilgan - bir xil natijani qaytaramiz, xato emas
      return { transaction: tx.id, perform_time: tx.performTime!.getTime(), state: 2 };
    }
    if (tx.state !== 'CREATED') {
      throw new PaymeRpcError(PaymeErrorCode.CANNOT_PERFORM_OPERATION, 'Amalni bajarib bo\'lmaydi');
    }

    const expired = Date.now() - tx.createTime.getTime() > TRANSACTION_TIMEOUT_MS;
    if (expired) {
      await this.prisma.paymeTransaction.update({
        where: { id: tx.id },
        data: { state: 'CANCELLED', cancelTime: new Date(), reason: 4 }, // 4 = "muddati tugagani uchun bekor qilindi"
      });
      throw new PaymeRpcError(PaymeErrorCode.CANNOT_PERFORM_OPERATION, "Tranzaksiya muddati tugagan");
    }

    // XAVFSIZLIK/IDEMPOTENTLIK: state='CREATED' shartli atomik update - Payme bir xil
    // so'rovni qayta yuborsa ham (retry), premium/referral mukofoti faqat BITTA marta beriladi.
    const claimed = await this.prisma.paymeTransaction.updateMany({
      where: { id: tx.id, state: 'CREATED' },
      data: { state: 'COMPLETED', performTime: new Date() },
    });

    if (claimed.count > 0) {
      const payment = await this.prisma.payment.findUniqueOrThrow({ where: { id: tx.paymentId } });
      await this.prisma.payment.update({ where: { id: payment.id }, data: { status: 'SUCCESS' } });
      await this.premium.extendPremium(payment.userId, payment.months, PremiumGrantSource.PAYMENT);
      await this.referral.rewardOnPremiumPurchase(payment.userId);
      this.logger.log(`Payme to'lovi tasdiqlandi: payment=${payment.id} user=${payment.userId}`);
    }

    const updated = await this.prisma.paymeTransaction.findUniqueOrThrow({ where: { id: tx.id } });
    return { transaction: updated.id, perform_time: updated.performTime!.getTime(), state: 2 };
  }

  async cancelTransaction(params: any) {
    const tx = await this.getTxOrThrow(params?.id);
    const reason = Number(params?.reason) || 0;

    if (tx.state === 'CANCELLED' || tx.state === 'CANCELLED_AFTER_COMPLETE') {
      // Idempotent: allaqachon bekor qilingan
      return { transaction: tx.id, cancel_time: tx.cancelTime!.getTime(), state: tx.state === 'CANCELLED' ? -1 : -2 };
    }

    const newState = tx.state === 'COMPLETED' ? 'CANCELLED_AFTER_COMPLETE' : 'CANCELLED';
    await this.prisma.paymeTransaction.update({
      where: { id: tx.id },
      data: { state: newState, cancelTime: new Date(), reason },
    });

    if (tx.state === 'COMPLETED') {
      // ESLATMA: pul qaytarilganda premium/referral bonusini avtomatik bekor qilish
      // (revoke) shu yerda amalga oshirilmagan - bu real pul harakati bo'lgani uchun
      // qo'lda admin tekshiruvi bilan qilingani xavfsizroq. Shu sababli faqat Payment
      // statusini FAILED qilamiz va logga yozamiz - admin panel (6-bosqich) buni
      // ko'rib, kerak bo'lsa premiumni qo'lda bekor qiladi.
      await this.prisma.payment.update({ where: { id: tx.paymentId }, data: { status: 'FAILED' } });
      this.logger.warn(
        `DIQQAT: to'langan tranzaksiya bekor qilindi (refund) - payment=${tx.paymentId}, tx=${tx.id}. Premium qo'lda tekshirilishi kerak.`,
      );
    } else {
      await this.prisma.payment.update({ where: { id: tx.paymentId }, data: { status: 'FAILED' } });
    }

    const updated = await this.prisma.paymeTransaction.findUniqueOrThrow({ where: { id: tx.id } });
    return {
      transaction: updated.id,
      cancel_time: updated.cancelTime!.getTime(),
      state: newState === 'CANCELLED' ? -1 : -2,
    };
  }

  async checkTransaction(params: any) {
    const tx = await this.getTxOrThrow(params?.id);
    return {
      create_time: tx.createTime.getTime(),
      perform_time: tx.performTime ? tx.performTime.getTime() : 0,
      cancel_time: tx.cancelTime ? tx.cancelTime.getTime() : 0,
      transaction: tx.id,
      state: this.stateToNumber(tx.state),
      reason: tx.reason ?? null,
    };
  }

  // --- Yordamchi funksiyalar ---

  private async findPaymentByAccount(account: any) {
    const orderId = account?.order_id;
    if (!orderId) {
      throw new PaymeRpcError(PaymeErrorCode.ACCOUNT_NOT_FOUND, "Buyurtma raqami ko'rsatilmagan", 'order_id');
    }
    const payment = await this.prisma.payment.findUnique({ where: { id: orderId } });
    if (!payment) {
      throw new PaymeRpcError(PaymeErrorCode.ACCOUNT_NOT_FOUND, 'Buyurtma topilmadi', 'order_id');
    }
    return payment;
  }

  private assertAmountMatches(paymentAmountSom: number, requestAmountTiyin: number) {
    const expectedTiyin = Math.round(paymentAmountSom * 100);
    if (Number(requestAmountTiyin) !== expectedTiyin) {
      throw new PaymeRpcError(PaymeErrorCode.INVALID_AMOUNT, "Noto'g'ri summa");
    }
  }

  private async getTxOrThrow(paymeId: string) {
    const tx = await this.prisma.paymeTransaction.findUnique({ where: { paymeId } });
    if (!tx) throw new PaymeRpcError(PaymeErrorCode.TRANSACTION_NOT_FOUND, 'Tranzaksiya topilmadi');
    return tx;
  }

  private stateToNumber(state: string): number {
    switch (state) {
      case 'CREATED':
        return 1;
      case 'COMPLETED':
        return 2;
      case 'CANCELLED':
        return -1;
      case 'CANCELLED_AFTER_COMPLETE':
        return -2;
      default:
        return 0;
    }
  }
}
