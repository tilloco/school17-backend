import { IsEmail, IsString, Length, IsOptional, MaxLength } from 'class-validator';

export class VerifyOtpDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(4, 6)
  code: string;

  // Faqat birinchi marta ro'yxatdan o'tishda keladi (onboarding)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  referredByCode?: string;
}