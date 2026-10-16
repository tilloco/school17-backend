import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class EmailRegisterDto {
  @IsEmail() @MaxLength(254) email!: string;
  // bcrypt faqat birinchi 72 baytni hisobga oladi: uzunroq parolni rad etamiz
  @IsString() @MinLength(8) @MaxLength(72) password!: string;
  @IsString() @MinLength(2) @MaxLength(100) name!: string;
  @IsIn(['STUDENT', 'TEACHER', 'GUARDIAN']) role!: 'STUDENT' | 'TEACHER' | 'GUARDIAN';
  @Matches(/^\d{4}-\d{2}-\d{2}$/) dateOfBirth!: string;
  @IsBoolean() acceptTerms!: boolean;
  @IsOptional() @IsString() @MaxLength(24) username?: string;
  @IsOptional() @IsIn(['uz', 'ru', 'en']) locale?: 'uz' | 'ru' | 'en';
}

export class EmailLoginDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MinLength(1) @MaxLength(72) password!: string;
}
