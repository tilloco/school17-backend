import { IsOptional, IsString, IsISO8601, MaxLength } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  // ISO 8601 sana, masalan "2026-12-15" — foydalanuvchi imtihonni qachon
  // topshirmoqchi bo'lishi (onboarding'da va istalgan vaqtda o'zgartirilishi mumkin)
  @IsOptional()
  @IsISO8601()
  examDate?: string;
}
