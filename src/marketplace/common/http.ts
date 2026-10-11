import { INestApplication } from '@nestjs/common';
import { raw } from 'express';

/** Provayder webhook'i uchun xom body (imzo body hash bo'yicha tekshiriladi), JSON parserdan OLDIN. */
export function configureRawWebhook(app: INestApplication) {
  app.use('/calls/webhook', raw({ type: () => true, limit: '100kb' }));
  // Fayl bo'laklari (1 MiB + zaxira): xom bayt sifatida qabul qilinadi
  app.use('/files/upload', raw({ type: () => true, limit: '1100kb' }));
}
