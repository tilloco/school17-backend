import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'crypto';
import { PaymeService } from './payme.service';
import { PaymeErrorCode, PaymeRpcError } from './payme-error';

// XAVFSIZLIK ESLATMASI: bu endpoint global JwtAuthGuard'dan tashqarida (Payme bizga JWT
// yubormaydi, o'rniga HTTP Basic Auth - login "Paycom", parol .env dagi PAYME_MERCHANT_KEY).
// Payme JSON-RPC protokoli har doim HTTP 200 kutadi, hatto xato holatida ham - shuning
// uchun bu yerda oddiy Nest exception/guard ishlatilmaydi, javob qo'lda formatlanadi.
//
// @SkipThrottle(): Payme ham qisqa vaqt ichida bir nechta JSON-RPC chaqiruvi yuborishi
// mumkin (CheckPerformTransaction -> CreateTransaction -> PerformTransaction ketma-ket) -
// global IP-cheklov haqiqiy to'lovlarni to'smasligi uchun bu yerda o'chirilgan. Yagona
// himoya - har bir so'rovdagi Basic Auth tekshiruvi (pastda, doimiy-vaqtli taqqoslash bilan).
@SkipThrottle()
@Controller('payments/payme')
export class PaymeController {
  constructor(
    private paymeService: PaymeService,
    private config: ConfigService,
  ) {}

  @Post()
  @HttpCode(200)
  async handle(@Body() body: any, @Headers('authorization') authHeader?: string) {
    const id = body?.id ?? null;

    if (!this.isAuthorized(authHeader)) {
      return { error: { code: PaymeErrorCode.INSUFFICIENT_PRIVILEGE, message: "Ruxsat yo'q" }, id };
    }

    try {
      const result = await this.dispatch(body?.method, body?.params);
      return { result, id };
    } catch (e) {
      if (e instanceof PaymeRpcError) {
        return { error: { code: e.code, message: e.message, data: e.data }, id };
      }
      // Kutilmagan (dasturiy) xato - Payme'ga "tizim xatosi" deb bildiramiz, ichki
      // tafsilotlarni tashqariga chiqarmaymiz
      return { error: { code: PaymeErrorCode.SYSTEM_ERROR, message: 'Tizim xatosi' }, id };
    }
  }

  private dispatch(method: string, params: any) {
    switch (method) {
      case 'CheckPerformTransaction':
        return this.paymeService.checkPerformTransaction(params);
      case 'CreateTransaction':
        return this.paymeService.createTransaction(params);
      case 'PerformTransaction':
        return this.paymeService.performTransaction(params);
      case 'CancelTransaction':
        return this.paymeService.cancelTransaction(params);
      case 'CheckTransaction':
        return this.paymeService.checkTransaction(params);
      default:
        throw new PaymeRpcError(PaymeErrorCode.METHOD_NOT_FOUND, 'Metod topilmadi');
    }
  }

  // Basic Auth: "Authorization: Basic base64(Paycom:MERCHANT_KEY)"
  private isAuthorized(authHeader?: string): boolean {
    const key = this.config.get<string>('PAYME_MERCHANT_KEY') || '';
    if (!authHeader?.startsWith('Basic ') || !key) return false;

    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    const expected = `Paycom:${key}`;

    const a = Buffer.from(decoded);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
