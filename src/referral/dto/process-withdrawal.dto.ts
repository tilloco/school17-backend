import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ProcessWithdrawalDto {
  @IsIn(['APPROVED', 'REJECTED', 'PAID'])
  status: 'APPROVED' | 'REJECTED' | 'PAID';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
