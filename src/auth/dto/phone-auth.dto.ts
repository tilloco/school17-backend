import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class PhoneRequestDto {
  @IsString() @MaxLength(24) phone!: string;
}

export class PhoneVerifyDto {
  @IsString() @MaxLength(24) phone!: string;
  @Matches(/^\d{6}$/) code!: string;
  // faqat yangi foydalanuvchi uchun (ikkinchi qadam):
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) name?: string;
  @IsOptional() @IsIn(['STUDENT', 'TEACHER', 'GUARDIAN']) role?: 'STUDENT' | 'TEACHER' | 'GUARDIAN';
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dateOfBirth?: string;
  @IsOptional() @IsBoolean() acceptTerms?: boolean;
  @IsOptional() @IsIn(['uz', 'ru', 'en']) locale?: 'uz' | 'ru' | 'en';
}
