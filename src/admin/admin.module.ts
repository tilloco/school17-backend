import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';

@Module({
  imports: [AdminAuthModule], // AdminJwtStrategy shu yerdan ro'yxatdan o'tadi
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
