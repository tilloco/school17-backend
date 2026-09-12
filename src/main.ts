import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { mkdirSync } from 'fs';
import { join } from 'path';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const isProd = process.env.NODE_ENV === 'production';

  // Avatar fayllari shu papkaga saqlanadi - server birinchi marta ishga tushganda yo'q
  // bo'lsa, avtomatik yaratiladi (aks holda birinchi yuklashda xato beradi)
  mkdirSync(join(process.cwd(), 'uploads', 'avatars'), { recursive: true });

  // XAVFSIZLIK: production'da kritik maxfiy sozlamalar bo'sh bo'lsa, server SHU YERDA
  // to'xtaydi - "keyin sozlab qo'yaman" bilan xavfsiz bo'lmagan holatda ishga tushishning
  // oldini oladi (masalan bo'sh JWT_SECRET bilan token'larni soxtalashtirish mumkin bo'lardi).
  if (isProd) {
    const required = ['JWT_SECRET', 'OTP_PEPPER', 'ADMIN_JWT_SECRET', 'ALLOWED_ORIGINS'];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      logger.error(`Production rejimida quyidagi .env qiymatlari MAJBURIY: ${missing.join(', ')}`);
      process.exit(1);
    }
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // /uploads/avatars/<fayl> manzili orqali rasmlarga to'g'ridan-to'g'ri (statik) kirish.
  // Bular ochiq (login talab qilmaydi) - profil rasmlari maxfiy emas, boshqa
  // foydalanuvchilar/admin panelda ko'rsatilishi kerak bo'lgani uchun.
  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads' });

  // XAVFSIZLIK: server proksi (nginx/load balancer) ortida ishlaydi deb hisoblanadi.
  // Buni sozlamasak, Express req.ip HAR DOIM proksi IP'sini ko'rsatadi - natijada
  // ThrottlerGuard (IP bo'yicha cheklov) BARCHA foydalanuvchilarni bitta "IP" deb
  // hisoblaydi va bittasi limitni tugatsa, boshqa hammaga to'siq qo'yiladi. TRUST_PROXY
  // - proksi qatlamlari soni (odatda 1). Proksi yo'q bo'lsa (masalan to'g'ridan-to'g'ri
  // internetga ochiq dev server), buni 0 qilib qo'ying - aks holda X-Forwarded-For
  // header'ini har kim o'zi qo'shib, IP-cheklovni chetlab o'tishi mumkin.
  const trustProxyHops = Number(process.env.TRUST_PROXY ?? 1);
  app.getHttpAdapter().getInstance().set('trust proxy', trustProxyHops);

  // Standart xavfsizlik HTTP headerlari (XSS, clickjacking va h.k. dan qisman himoya)
  app.use(helmet());

  // Kelayotgan JSON'larni avtomatik tekshirish va noto'g'ri ma'lumotni rad etish.
  // whitelist+forbidNonWhitelisted: DTO'da dekoratorsiz maydon bo'lsa so'rov rad
  // etiladi - shuning uchun HAR BIR DTO maydonida class-validator dekoratori bo'lishi
  // SHART (masalan ClickWebhookDto - Click webhook'ini qabul qilish uchun).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // CORS: faqat .env'da ruxsat berilgan originlar (mobil ilova + admin panel).
  // XAVFSIZLIK: production'da ALLOWED_ORIGINS bo'sh bo'lsa endi server ishga
  // tushmaydi (yuqoridagi tekshiruv) - shuning uchun bu yerda "aks holda hammaga
  // ochiq" holati faqat local development uchun qoladi, productionga sizib chiqmaydi.
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    credentials: true,
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(`Backend ishga tushdi: http://localhost:${port} (NODE_ENV=${process.env.NODE_ENV || 'development'})`);
}
bootstrap();
