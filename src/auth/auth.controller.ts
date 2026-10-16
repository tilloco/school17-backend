import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { GoogleLoginDto } from './dto/google-login.dto';
import { PhoneRequestDto, PhoneVerifyDto } from './dto/phone-auth.dto';
import { EmailLoginDto, EmailRegisterDto } from './dto/email-auth.dto';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  // POST /auth/google  { "idToken": "..." }
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('google')
  loginWithGoogle(@Body() dto: GoogleLoginDto) {
    return this.authService.loginWithGoogle(dto.idToken);
  }

  // POST /auth/email/register  - e-pochta + parol bilan ro'yxatdan o'tish (rol, tug'ilgan sana, shartlarga rozilik shart)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('email/register')
  registerEmail(@Body() dto: EmailRegisterDto) {
    return this.authService.registerEmail(dto);
  }

  // POST /auth/email/login
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('email/login')
  @HttpCode(200)
  loginEmail(@Body() dto: EmailLoginDto) {
    return this.authService.loginEmail(dto);
  }

  // POST /auth/phone/request  { phone } - Telegram'ning rasmiy kodi (Gateway) yuboriladi
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('phone/request')
  @HttpCode(200)
  requestPhone(@Body() dto: PhoneRequestDto) {
    return this.authService.requestPhoneCode(dto.phone);
  }

  // POST /auth/phone/verify  { phone, code, [name, role, dateOfBirth, acceptTerms] }
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('phone/verify')
  @HttpCode(200)
  verifyPhone(@Body() dto: PhoneVerifyDto) {
    return this.authService.verifyPhoneCode(dto);
  }
}
