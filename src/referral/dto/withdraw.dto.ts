import { IsInt, Min } from 'class-validator';

export class WithdrawDto {
  @IsInt()
  @Min(10000) // minimal yechib olish miqdori (so'mda) - mayda-chuyda so'rovlarning oldini oladi
  amount: number;
}
