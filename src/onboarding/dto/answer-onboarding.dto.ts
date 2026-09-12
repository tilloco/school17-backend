import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class AnswerOnboardingDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  answer: string;
}