import { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { raw } from 'express';
import helmet from 'helmet';

/** Provayder webhook'i uchun xom body (imzo body hash bo'yicha tekshiriladi), JSON parserdan OLDIN. */
export function configureRawWebhook(app: INestApplication) {
  app.use('/calls/webhook', raw({ type: () => true, limit: '100kb' }));
  // Fayl bo'laklari (1 MiB + zaxira): xom bayt sifatida qabul qilinadi
  app.use('/files/upload', raw({ type: () => true, limit: '1100kb' }));
}

/**
 * Umumiy HTTP himoyasi: main.ts va test ilovasi BIR XIL sozlamani ishlatadi (testlar haqiqiy sozlamani tekshiradi).
 * helmet (xavfsizlik headerlari), xom body yo'llari, qat'iy validatsiya (noma'lum maydon = 400), CORS (ALLOWED_ORIGINS).
 */
export function configureHttpSecurity(app: INestApplication, env: NodeJS.ProcessEnv = process.env) {
  app.use(helmet());
  configureRawWebhook(app);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
  // Production'da ALLOWED_ORIGINS bo'sh bo'lsa server ishga tushmaydi (main.ts); bu yerdagi "hammaga ochiq" faqat lokal dev uchun.
  app.enableCors({ origin: allowedOrigins.length > 0 ? allowedOrigins : true, credentials: true });
}
