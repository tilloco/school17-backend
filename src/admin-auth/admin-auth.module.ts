import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AdminAuthService } from './admin-auth.service';
import { AdminAuthController } from './admin-auth.controller';
import { AdminJwtStrategy } from './admin-jwt.strategy';

@Module({
  imports: [
    PassportModule,
    // Standart secret bermaymiz - AdminAuthService har bir sign() chaqiruvida
    // ADMIN_JWT_SECRET'ni o'zi ko'rsatadi, shunda oddiy foydalanuvchi JWT
    // moduli bilan hech qanday umumiy sozlama bo'lmaydi.
    JwtModule.register({}),
  ],
  controllers: [AdminAuthController],
  providers: [AdminAuthService, AdminJwtStrategy],
  exports: [AdminAuthService],
})
export class AdminAuthModule {}
