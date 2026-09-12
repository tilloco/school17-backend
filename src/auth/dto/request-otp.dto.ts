import { IsEmail } from 'class-validator';

export class RequestOtpDto {
  @IsEmail({}, { message: "Email noto'g'ri formatda" })
  email: string;
}
