import { IsIn, IsInt } from 'class-validator';

export class InitPaymentDto {
  @IsIn(['CLICK', 'PAYME'])
  provider: 'CLICK' | 'PAYME';

  @IsInt()
  @IsIn([1, 3]) // hozircha faqat 1 va 3 oylik tarif bor (PREMIUM_PRICING bilan mos bo'lishi kerak)
  months: number;
}
