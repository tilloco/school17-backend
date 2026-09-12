import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

// Buni istalgan admin controller/route ustiga @UseGuards(AdminJwtAuthGuard)
// qo'yib ishlating - faqat /admin/auth/login orqali muvaffaqiyatli kirgan
// adminlarga ruxsat beradi (oddiy foydalanuvchi tokeni bilan ishlamaydi).
@Injectable()
export class AdminJwtAuthGuard extends AuthGuard('admin-jwt') {}
