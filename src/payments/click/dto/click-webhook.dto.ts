import { IsIn, IsOptional, IsString } from 'class-validator';

// Click SHOP API so'rovi x-www-form-urlencoded shaklida keladi va sonlarni ham satr
// sifatida yuborishi mumkin, shuning uchun bu yerda qat'iy tur (Number) emas, satr
// sifatida qabul qilinadi - qiymatlar ClickService ichida qo'lda tekshiriladi/parse
// qilinadi (Click'ning o'ziga xos xato formatini qaytarishimiz kerak, umumiy 400 emas).
//
// MUHIM: global ValidationPipe `whitelist: true, forbidNonWhitelisted: true` bilan
// ishlaydi - bu degani, hech qanday class-validator dekoratoriga ega bo'lmagan maydon
// "whitelist"dan tashqarida deb hisoblanib, so'rov 400 xato bilan RAD ETILADI. Shuning
// uchun quyidagi HAR BIR maydonda kamida @IsString() bo'lishi SHART - aks holda Click
// hech qachon muvaffaqiyatli webhook yubora olmaydi (real to'lovlar tasdiqlanmay qoladi).
export class ClickWebhookDto {
  @IsString()
  click_trans_id: string;

  @IsString()
  service_id: string;

  @IsOptional()
  @IsString()
  click_paydoc_id?: string;

  @IsString()
  merchant_trans_id: string;

  @IsOptional()
  @IsString()
  merchant_prepare_id?: string; // faqat Complete (action=1) da keladi

  @IsString()
  amount: string;

  @IsIn(['0', '1'])
  action: string; // '0' = Prepare, '1' = Complete

  @IsString()
  error: string;

  @IsOptional()
  @IsString()
  error_note?: string;

  @IsString()
  sign_time: string;

  @IsString()
  sign_string: string;
}
