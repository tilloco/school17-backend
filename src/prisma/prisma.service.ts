import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// Bu servis butun ilova bo'ylab bitta PrismaClient nusxasini ulashadi.
// Har bir module PrismaService'ni inject qilib, ma'lumotlar bazasi bilan ishlaydi.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
