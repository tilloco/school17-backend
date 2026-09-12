import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

// Bu guard'ni istalgan controller/route ustiga @UseGuards(JwtAuthGuard)
// qo'yib, faqat tizimga kirgan foydalanuvchilarga ruxsat berish uchun ishlatiladi.
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}