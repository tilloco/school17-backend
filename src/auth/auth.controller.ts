import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { GoogleLoginDto } from './dto/google-login.dto';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  // POST /auth/request-otp  { "email": "user@example.com" }
  // IP bo'yicha daqiqasiga 3 ta so'rov bilan cheklangan (global 60/daqiqadan tashqari,
  // qo'shimcha himoya qatlami - service ichida esa email bo'yicha cooldown/hourly limit bor).
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('request-otp')
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.authService.requestOtp(dto.email);
  }

  // POST /auth/verify-otp  { "email": "...", "code": "123456", "name": "Ali" }
  // IP bo'yicha daqiqasiga 10 ta so'rov bilan cheklangan (brute-force'ni sekinlashtirish uchun;
  // asosiy himoya - service ichidagi har-kod-uchun attempts limiti).
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('verify-otp')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto.email, dto.code, dto.name, dto.referredByCode);
  }
  // POST /auth/google  { "idToken": "..." }
@Throttle({ default: { limit: 10, ttl: 60_000 } })
@Post('google')
loginWithGoogle(@Body() dto: GoogleLoginDto) {
  return this.authService.loginWithGoogle(dto.idToken);
}
}