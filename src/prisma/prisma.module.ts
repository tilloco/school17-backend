import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

// @Global() - har bir module PrismaModule'ni alohida import qilmasdan
// PrismaService'dan foydalana oladi.
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
