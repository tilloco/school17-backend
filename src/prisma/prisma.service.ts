import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

const CONNECT_TIMEOUT_MS = 10_000; // har bir urinish uchun maksimal kutish vaqti
const MAX_RETRIES = 3; // jami urinishlar soni

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.connectWithTimeout();
        this.logger.log('Ma\'lumotlar bazasiga muvaffaqiyatli ulandi');
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`DB ulanish urinishi ${attempt}/${MAX_RETRIES} muvaffaqiyatsiz: ${message}`);
        if (attempt === MAX_RETRIES) {
          this.logger.error('Ma\'lumotlar bazasiga ulanib bo\'lmadi, server to\'xtatiladi');
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
  }

  private connectWithTimeout(): Promise<void> {
    return Promise.race([
      this.$connect(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`DB ulanish ${CONNECT_TIMEOUT_MS}ms ichida tugamadi`)),
          CONNECT_TIMEOUT_MS,
        ),
      ),
    ]);
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}