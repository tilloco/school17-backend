import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class SaveExamAnswerDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3)
  chosenIndex?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  partAText?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  partBText?: string;
}